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

  // Build Edmunds VDP URL
  const slug = (item.style ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const listingUrl = year && slug
    ? `https://www.edmunds.com/tesla/model-x/${year}/${slug}/vin/${vin}/`
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
    imageUrl: null, // Edmunds images require separate photo URLs
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
export async function scrapeEdmunds(): Promise<RawListing[]> {
  console.log("[Edmunds] Launching Python scraper (nodriver)...");

  const proc = Bun.spawn(["python", FETCH_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  // Log stderr (progress messages from the Python script)
  if (stderr.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(line);
    }
  }

  // Extract JSON results between markers
  const startMarker = "__EDMUNDS_RESULTS_START__";
  const endMarker = "__EDMUNDS_RESULTS_END__";
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error("[Edmunds] No results markers found in output.");
    return [];
  }

  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

  let items: any[];
  try {
    items = JSON.parse(jsonStr);
  } catch (err) {
    console.error("[Edmunds] Failed to parse JSON results:", (err as Error).message);
    return [];
  }

  const results: RawListing[] = [];
  for (const item of items) {
    const parsed = parseItem(item);
    if (parsed) results.push(parsed);
  }

  if (results.length === 0) {
    console.log("[Edmunds] 0 listings — likely blocked by Akamai");
  } else {
    console.log(`[Edmunds] Done — ${results.length} listings`);
  }

  return results;
}
