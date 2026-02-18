import type { RawListing } from "./types.ts";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir =
  typeof (import.meta as any).dir === "string"
    ? (import.meta as any).dir
    : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dir, "../..");
const FETCH_SCRIPT = resolve(PROJECT_ROOT, "scripts/edmunds-fetch.py");

function parseItem(item: any): RawListing | null {
  const vin = (item.vin ?? "").toUpperCase();
  if (!vin || vin.length !== 17) return null;

  const price = item.price ?? 0;
  const mileage = item.mileage ?? 0;
  const year = item.year ?? 0;
  const trim = item.trim ?? "";

  const extColor = item.exteriorColor ?? item.exteriorGenericColor ?? "";
  const intColor = item.interiorColor ?? item.interiorGenericColor ?? "";

  const dealerCity = item.dealerCity ?? "";
  const dealerState = item.dealerState ?? "";
  const dealerLocation = dealerCity && dealerState
    ? `${dealerCity}, ${dealerState}`
    : dealerCity || dealerState;

  // Build Edmunds VDP URL (canonical format: /tesla/model-x/{year}/vin/{VIN}/)
  const listingUrl = year
    ? `https://www.edmunds.com/tesla/model-x/${year}/vin/${vin}/`
    : `https://www.edmunds.com/tesla/model-x/inventory/?vin=${vin}`;

  // Map history fields
  let titleStatus: string | null = null;
  if (item.cleanTitle === true) titleStatus = "clean";
  else if (item.salvageHistory === true) titleStatus = "salvage";
  else if (item.lemonHistory === true) titleStatus = "lemon";
  else if (item.cleanTitle === false) titleStatus = "branded";

  let accidentHistory: "clean" | "accident" | "unknown" = "unknown";
  if (item.noAccidents === true) accidentHistory = "clean";
  else if (item.noAccidents === false) accidentHistory = "accident";

  // Listed date from epoch ms
  const listedEpoch = item.listedSince ?? item.firstPublishedDate ?? null;
  const listedDate = listedEpoch
    ? new Date(listedEpoch).toISOString()
    : null;

  return {
    vin,
    source: "edmunds",
    url: listingUrl,
    price,
    mileage,
    year,
    trim,
    exteriorColor: extColor,
    interiorColor: intColor,
    seatCount: item.numberOfSeats ?? null,
    dealerName: item.dealerName ?? "",
    dealerLocation,
    imageUrl: item.imageUrl ?? null,
    listedDate,
    titleStatus,
    accidentHistory,
  };
}

/**
 * Scrapes Edmunds used Model X inventory using a Python subprocess
 * (nodriver / undetected Chrome) to bypass Akamai Bot Manager.
 * Extracts rich data from __PRELOADED_STATE__ across paginated results.
 */
export async function scrapeEdmunds(
  onProgress?: (msg: string) => void,
  onPartialResults?: (batch: RawListing[]) => void,
): Promise<RawListing[]> {
  const msg = "[Edmunds] Launching Python scraper (nodriver)...";
  console.log(msg);
  onProgress?.(msg);

  const proc = Bun.spawn(["python", FETCH_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // 175s timeout — kill subprocess before the 180s refresh-level timeout hits
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    const tmsg = "[Edmunds] Timed out after 175s — killed subprocess";
    console.error(tmsg);
    onProgress?.(tmsg);
  }, 175_000);

  // Incrementally collect results from per-page streaming markers
  const results: RawListing[] = [];

  // Stream stderr line-by-line for real-time progress
  const stderrReader = proc.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  let stderrBuf = "";
  const stderrDone = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf += stderrDecoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nlIdx).trim();
          stderrBuf = stderrBuf.slice(nlIdx + 1);
          if (line) {
            console.log(line);
            onProgress?.(line);
          }
        }
      }
      if (stderrBuf.trim()) {
        console.log(stderrBuf.trim());
        onProgress?.(stderrBuf.trim());
      }
    } catch {}
  })();

  // Stream stdout and parse per-page results incrementally
  const stdoutReader = proc.stdout.getReader();
  const stdoutDecoder = new TextDecoder();
  let stdoutBuf = "";
  const PAGE_START = "__EDMUNDS_PAGE_RESULTS__";
  const PAGE_END = "__END_PAGE__";

  const stdoutDone = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuf += stdoutDecoder.decode(value, { stream: true });

        // Parse all complete page markers in the buffer
        let startIdx: number;
        while ((startIdx = stdoutBuf.indexOf(PAGE_START)) !== -1) {
          const endIdx = stdoutBuf.indexOf(PAGE_END, startIdx);
          if (endIdx === -1) break; // incomplete page, wait for more data

          const jsonStr = stdoutBuf.slice(startIdx + PAGE_START.length, endIdx);
          stdoutBuf = stdoutBuf.slice(endIdx + PAGE_END.length);

          try {
            const items: any[] = JSON.parse(jsonStr);
            const batch: RawListing[] = [];
            for (const item of items) {
              const parsed = parseItem(item);
              if (parsed) {
                results.push(parsed);
                batch.push(parsed);
              }
            }
            if (batch.length > 0) onPartialResults?.(batch);
            onProgress?.(`[Edmunds] Streaming: ${results.length} listings so far`);
          } catch (err) {
            console.error("[Edmunds] Failed to parse page results:", (err as Error).message);
          }
        }
      }
    } catch {}
  })();

  await Promise.all([stderrDone, stdoutDone]);
  await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    console.log(`[Edmunds] Timed out but collected ${results.length} partial listings`);
    return results; // return whatever we got before timeout
  }

  // Also check for the final bulk marker (backward compat)
  const FINAL_START = "__EDMUNDS_RESULTS_START__";
  const FINAL_END = "__EDMUNDS_RESULTS_END__";
  const finalStartIdx = stdoutBuf.indexOf(FINAL_START);
  const finalEndIdx = stdoutBuf.indexOf(FINAL_END);
  if (finalStartIdx !== -1 && finalEndIdx !== -1) {
    try {
      const jsonStr = stdoutBuf.slice(finalStartIdx + FINAL_START.length, finalEndIdx).trim();
      const items: any[] = JSON.parse(jsonStr);
      // Only use final results if streaming yielded nothing (fallback)
      if (results.length === 0) {
        for (const item of items) {
          const parsed = parseItem(item);
          if (parsed) results.push(parsed);
        }
      }
    } catch {}
  }

  if (results.length === 0) {
    console.log("[Edmunds] 0 listings — likely blocked by Akamai");
  } else {
    console.log(`[Edmunds] Done — ${results.length} listings`);
  }

  return results;
}

/**
 * Scrape a single Edmunds listing by VIN using curl on the VDP page.
 * Much faster than the full scraper — no browser, no pagination.
 * Returns null if blocked by Akamai or data can't be extracted.
 */
export async function scrapeEdmundsByVin(
  vin: string,
  year: number
): Promise<RawListing | null> {
  const vdpUrl = `https://www.edmunds.com/tesla/model-x/${year}/vin/${vin}/`;
  console.log(`[Edmunds] Fetching VDP for ${vin}`);

  const proc = Bun.spawn(
    [
      "curl", "-s", "-L",
      "--max-time", "30",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H", "Accept-Language: en-US,en;q=0.9",
      vdpUrl,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const html = await new Response(proc.stdout).text();
  await proc.exited;

  if (!html || html.length < 1000) {
    console.log(`[Edmunds] VDP for ${vin}: empty/short response — likely blocked`);
    return null;
  }

  // Check for Akamai block
  if (html.includes("Access Denied") || html.includes("Reference #")) {
    console.log(`[Edmunds] VDP for ${vin}: blocked by Akamai`);
    return null;
  }

  // Try __PRELOADED_STATE__ extraction
  const marker = "window.__PRELOADED_STATE__";
  const stateStart = html.indexOf(marker);
  if (stateStart !== -1) {
    try {
      const eqPos = html.indexOf("=", stateStart + marker.length);
      if (eqPos !== -1) {
        const scriptEnd = html.indexOf("</script>", eqPos);
        if (scriptEnd !== -1) {
          let jsonEnd = html.lastIndexOf(";", scriptEnd);
          if (jsonEnd <= eqPos) jsonEnd = scriptEnd;
          const jsonStr = html.slice(eqPos + 1, jsonEnd).trim();
          const state = JSON.parse(jsonStr);

          // SRP structure: inventory.searchResults.inventories.results[]
          const srpResults = state?.inventory?.searchResults?.inventories?.results;
          if (Array.isArray(srpResults)) {
            for (const r of srpResults) {
              if ((r.vin || "").toUpperCase() === vin.toUpperCase()) {
                return parsePreloadedItem(r);
              }
            }
          }

          // VDP structure variations
          for (const path of [
            state?.inventoryDetail?.inventory,
            state?.vehicleDetail?.inventory,
            state?.inventory?.detail,
          ]) {
            if (path && (path.vin || "").toUpperCase() === vin.toUpperCase()) {
              return parsePreloadedItem(path);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Edmunds] VDP parse error for ${vin}:`, (err as Error).message);
    }
  }

  // Fallback: try JSON-LD structured data
  return extractFromJsonLd(html, vin);
}

/** Parse a vehicle object from __PRELOADED_STATE__ into a RawListing */
function parsePreloadedItem(r: any): RawListing | null {
  const vi = r.vehicleInfo || {};
  const si = vi.styleInfo || {};
  const colors = vi.vehicleColors || {};
  const dealer = r.dealerInfo || {};
  const addr = dealer.address || {};
  const prices = r.prices || {};
  const history = r.historyInfo || {};

  // Extract image URL from multiple possible paths
  const photos = r.photoUrls || r.photos || vi.photoUrls || [];
  let imageUrl: string | null = null;
  if (Array.isArray(photos) && photos.length > 0) {
    const first = photos[0];
    imageUrl = typeof first === "string" ? first : (first?.url || first?.src || first?.href || null);
  }
  if (!imageUrl) {
    const media = r.mediaData || vi.mediaData || {};
    const thumbs = media.thumbnails || media.photos || [];
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      const t = thumbs[0];
      imageUrl = typeof t === "string" ? t : (t?.url || t?.src || null);
    }
  }

  return parseItem({
    vin: (r.vin || "").toUpperCase(),
    price: prices.displayPrice || prices.advertisedPrice || 0,
    mileage: vi.mileage || 0,
    year: si.year || 0,
    trim: si.trim || "",
    numberOfSeats: si.numberOfSeats || null,
    exteriorColor: colors.exterior?.name || "",
    exteriorGenericColor: colors.exterior?.genericName || "",
    interiorColor: colors.interior?.name || "",
    interiorGenericColor: colors.interior?.genericName || "",
    dealerName: dealer.name || "",
    dealerCity: addr.city || "",
    dealerState: addr.stateCode || "",
    imageUrl,
    firstPublishedDate: r.firstPublishedDate || null,
    listedSince: r.listedSince || null,
    cleanTitle: history.cleanTitle ?? null,
    salvageHistory: history.salvageHistory ?? null,
    lemonHistory: history.lemonHistory ?? null,
    noAccidents: history.noAccidents ?? null,
  });
}

/** Try extracting vehicle data from JSON-LD on the page */
function extractFromJsonLd(html: string, vin: string): RawListing | null {
  const ldMatches = html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const m of ldMatches) {
    try {
      const ld = JSON.parse(m[1]);
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        if (item["@type"] === "Car" || item["@type"] === "Vehicle") {
          const ldVin = (item.vehicleIdentificationNumber || "").toUpperCase();
          if (ldVin === vin.toUpperCase()) {
            return parseItem({
              vin: ldVin,
              price: parseInt(item.offers?.price || "0", 10),
              mileage: parseInt(item.mileageFromOdometer?.value || "0", 10),
              year: parseInt(item.modelDate || item.vehicleModelDate || "0", 10),
              trim: item.vehicleConfiguration || "",
              exteriorColor: item.color || "",
              interiorColor: item.vehicleInteriorColor || "",
              dealerName: item.offers?.seller?.name || "",
              dealerCity: "",
              dealerState: "",
            });
          }
        }
      }
    } catch {}
  }
  return null;
}
