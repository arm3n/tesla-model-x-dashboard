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
 * Batch-scrape Edmunds VDP pages using nodriver (undetected Chrome).
 * Opens ONE browser session, visits each VIN's stored URL, extracts data.
 * Much more reliable than curl for Akamai-protected pages.
 */
export async function scrapeEdmundsVdp(
  vins: { vin: string; year: number }[],
  onProgress?: (msg: string) => void,
): Promise<RawListing[]> {
  if (vins.length === 0) return [];

  const VDP_SCRIPT = resolve(PROJECT_ROOT, "scripts/edmunds-vdp-fetch.py");
  const args = vins.map(v => `${v.vin}:${v.year}`);
  const msg = `[Edmunds VDP] Launching nodriver for ${vins.length} VIN(s)...`;
  console.log(msg);
  onProgress?.(msg);

  const proc = Bun.spawn(["python", VDP_SCRIPT, ...args], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // 120s timeout (generous — each VDP takes ~10-15s)
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    const tmsg = "[Edmunds VDP] Timed out after 120s";
    console.error(tmsg);
    onProgress?.(tmsg);
  }, 120_000);

  const results: RawListing[] = [];

  // Stream stderr for progress
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

  // Stream stdout and parse per-VIN results
  const stdoutReader = proc.stdout.getReader();
  const stdoutDecoder = new TextDecoder();
  let stdoutBuf = "";
  const RESULT_START = "__VDP_RESULT__";
  const MISS_START = "__VDP_MISS__";
  const MARKER_END = "__END_VDP__";

  const stdoutDone = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuf += stdoutDecoder.decode(value, { stream: true });

        // Parse complete markers
        let idx: number;
        while (true) {
          const resultIdx = stdoutBuf.indexOf(RESULT_START);
          const missIdx = stdoutBuf.indexOf(MISS_START);

          // Find whichever marker comes first
          if (resultIdx === -1 && missIdx === -1) break;
          if (resultIdx !== -1 && (missIdx === -1 || resultIdx < missIdx)) {
            const endIdx = stdoutBuf.indexOf(MARKER_END, resultIdx);
            if (endIdx === -1) break;
            const jsonStr = stdoutBuf.slice(resultIdx + RESULT_START.length, endIdx);
            stdoutBuf = stdoutBuf.slice(endIdx + MARKER_END.length);
            try {
              const item = JSON.parse(jsonStr);
              const parsed = parseItem(item);
              if (parsed) results.push(parsed);
            } catch (err) {
              console.error("[Edmunds VDP] Parse error:", (err as Error).message);
            }
          } else if (missIdx !== -1) {
            const endIdx = stdoutBuf.indexOf(MARKER_END, missIdx);
            if (endIdx === -1) break;
            const missVin = stdoutBuf.slice(missIdx + MISS_START.length, endIdx).trim();
            stdoutBuf = stdoutBuf.slice(endIdx + MARKER_END.length);
            onProgress?.(`[Edmunds VDP] No data for ${missVin} (blocked or delisted)`);
          }
        }
      }
    } catch {}
  })();

  await Promise.all([stderrDone, stdoutDone]);
  await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    console.log(`[Edmunds VDP] Timed out but collected ${results.length} partial results`);
  } else {
    console.log(`[Edmunds VDP] Done — ${results.length}/${vins.length} VINs fetched`);
  }

  return results;
}

