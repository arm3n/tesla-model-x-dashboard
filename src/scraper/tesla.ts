import type { RawListing } from "./types.ts";
import { decodeOptionCodes } from "../vin/option-codes.ts";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir =
  typeof (import.meta as any).dir === "string"
    ? (import.meta as any).dir
    : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dir, "../..");
const FETCH_SCRIPT = resolve(PROJECT_ROOT, "scripts/tesla-fetch.py");

function parseItem(item: any): RawListing | null {
  const vin = (item.VIN ?? item.vin ?? "").toUpperCase();
  if (!vin || vin.length !== 17) return null;

  const optionCodes: string[] = item.OptionCodeList ?? item.OPTIONCODELIST ?? [];
  const optionCodesStr: string = typeof optionCodes === "string" ? optionCodes : "";
  const codeList = Array.isArray(optionCodes)
    ? optionCodes
    : optionCodesStr.split(",").filter(Boolean);

  let seatCount: number | null = item.seatCount ?? null;
  const trimStr = (item.TRIM ?? item.TrimName ?? "").toLowerCase();
  if (!seatCount) {
    for (const code of codeList) {
      if (/6.?seat/i.test(code) || code === "ST02" || code === "MTY06") seatCount = 6;
      else if (/7.?seat/i.test(code) || code === "ST03" || code === "MTY07") seatCount = 7;
      else if (/5.?seat/i.test(code) || code === "ST01" || code === "MTY05") seatCount = 5;
    }
  }
  if (!seatCount && trimStr.includes("6 seat")) seatCount = 6;
  if (!seatCount && trimStr.includes("7 seat")) seatCount = 7;

  const price = item.Price ?? item.PurchasePrice ?? item.price ?? 0;
  const mileage = item.Odometer ?? item.OdometerValue ?? item.odometer ?? 0;
  const year = item.Year ?? item.year ?? 0;
  const trim = item.TRIM ?? item.TrimName ?? item.trim ?? "";

  // Decode option codes to fill in colors if not directly available
  const decoded = codeList.length > 0 ? decodeOptionCodes(codeList) : null;
  const extColor = item.PAINT ?? item.ExteriorColor ?? item.exteriorColor ?? decoded?.exteriorColor ?? "";
  const intColor = item.INTERIOR ?? item.InteriorColor ?? item.interiorColor ?? decoded?.interiorColor ?? "";

  const city = item.City ?? item.city ?? "";
  const state = item.StateProvince ?? item.state ?? "";
  const location = city && state ? `${city}, ${state}` : city || state;

  const images = item.CompositorViews?.frontView ?? item.imageUrl ?? item.ImageUrl ?? null;
  const titleStatus = item.TitleStatus ?? item.titleStatus ?? null;

  return {
    vin,
    source: "tesla",
    url: `https://www.tesla.com/mx/order/${vin}`,
    price,
    mileage,
    year,
    trim,
    exteriorColor: extColor,
    interiorColor: intColor,
    seatCount,
    dealerName: "Tesla",
    dealerLocation: location,
    imageUrl: images,
    listedDate: item.DisplayDate ?? item.firstSeenDate ?? null,
    optionCodes: codeList,
    titleStatus: titleStatus === "CLEAN" ? "clean" : titleStatus,
  };
}

/**
 * Scrapes Tesla's used Model X inventory using a Python subprocess
 * (nodriver / undetected Chrome) to bypass Akamai Bot Manager.
 */
export async function scrapeTesla(): Promise<RawListing[]> {
  console.log("[Tesla] Launching Python scraper (nodriver)...");

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

  // Log stderr (contains progress messages from the Python script)
  if (stderr.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(line);
    }
  }

  // Extract JSON results between markers
  const startMarker = "__TESLA_RESULTS_START__";
  const endMarker = "__TESLA_RESULTS_END__";
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error("[Tesla] No results markers found in output.");
    return [];
  }

  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

  let items: any[];
  try {
    items = JSON.parse(jsonStr);
  } catch (err) {
    console.error("[Tesla] Failed to parse JSON results:", (err as Error).message);
    return [];
  }

  const results: RawListing[] = [];
  for (const item of items) {
    const parsed = parseItem(item);
    if (parsed) results.push(parsed);
  }

  if (results.length === 0) {
    console.log("[Tesla] 0 listings — likely blocked by Akamai");
  } else {
    console.log(`[Tesla] Done — ${results.length} listings`);
  }

  return results;
}
