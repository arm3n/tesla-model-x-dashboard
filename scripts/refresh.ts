import { scrapeMarketCheck } from "../src/scraper/marketcheck.ts";
import { scrapeCarsCom } from "../src/scraper/cars-com.ts";
import { scrapeCarGurus } from "../src/scraper/cargurus.ts";
import { scrapeTesla } from "../src/scraper/tesla.ts";
import { scrapeTrueCar } from "../src/scraper/truecar.ts";
import { scrapeAutotrader } from "../src/scraper/autotrader.ts";
import { scrapeEbayMotors } from "../src/scraper/ebay-motors.ts";
import { scrapeEdmunds } from "../src/scraper/edmunds.ts";
import { scrapeCarfax } from "../src/scraper/carfax.ts";
import { normalize, filterListings } from "../src/normalize.ts";
import {
  upsertListings,
  markInactive,
  getExistingListingsMap,
} from "../src/db.ts";
import type { RawListing } from "../src/scraper/types.ts";

export type ProgressCallback = (msg: string) => void;

export interface RefreshStats {
  marketcheck: number;
  tesla: number;
  autotrader: number;
  truecar: number;
  edmunds: number;
  carfax: number;
  ebay: number;
  carsCom: number;
  carGurus: number;
  total: number;
  filtered: number;
}

interface ScraperDef {
  name: string;
  key: keyof Omit<RefreshStats, "total" | "filtered">;
  fn: () => Promise<RawListing[]>;
}

const SCRAPERS: ScraperDef[] = [
  { name: "Tesla Inventory", key: "tesla", fn: scrapeTesla },
  { name: "MarketCheck", key: "marketcheck", fn: scrapeMarketCheck },
  { name: "Autotrader", key: "autotrader", fn: scrapeAutotrader },
  { name: "TrueCar", key: "truecar", fn: scrapeTrueCar },
  { name: "Edmunds", key: "edmunds", fn: scrapeEdmunds },
  { name: "CarFax", key: "carfax", fn: scrapeCarfax },
  { name: "eBay Motors", key: "ebay", fn: scrapeEbayMotors },
  { name: "Cars.com", key: "carsCom", fn: scrapeCarsCom },
  { name: "CarGurus", key: "carGurus", fn: scrapeCarGurus },
];

/** Map from source key/name to the scraper key used in SCRAPERS */
const SOURCE_KEY_MAP: Record<string, string> = {
  marketcheck: "marketcheck",
  "cars.com": "carsCom",
  carscom: "carsCom",
  cargurus: "carGurus",
  tesla: "tesla",
  truecar: "truecar",
  autotrader: "autotrader",
  ebay: "ebay",
  edmunds: "edmunds",
  carfax: "carfax",
};

export async function refresh(
  onProgress?: ProgressCallback,
  onlySources?: string[]
): Promise<RefreshStats> {
  const log = (msg: string) => {
    console.log(msg);
    onProgress?.(msg);
  };

  log("Starting data refresh...");
  const start = Date.now();

  // Filter scrapers if specific sources requested
  let activescrapers = SCRAPERS;
  if (onlySources && onlySources.length > 0) {
    const allowedKeys = new Set(
      onlySources.map((s) => SOURCE_KEY_MAP[s.toLowerCase()] ?? s.toLowerCase())
    );
    activescrapers = SCRAPERS.filter((s) => allowedKeys.has(s.key));
    log(`Running ${activescrapers.length} of ${SCRAPERS.length} scrapers: ${activescrapers.map(s => s.name).join(", ")}`);
  }

  for (const s of activescrapers) {
    log(`Fetching from ${s.name}...`);
  }

  const results = await Promise.allSettled(
    activescrapers.map((s) =>
      s.fn().then((r) => {
        log(`${s.name}: ${r.length} listings found`);
        return r;
      })
    )
  );

  const stats: RefreshStats = {
    marketcheck: 0,
    tesla: 0,
    autotrader: 0,
    truecar: 0,
    edmunds: 0,
    carfax: 0,
    ebay: 0,
    carsCom: 0,
    carGurus: 0,
    total: 0,
    filtered: 0,
  };

  const allRaw: RawListing[] = [];

  for (let i = 0; i < activescrapers.length; i++) {
    const result = results[i]!;
    const scraper = activescrapers[i]!;
    if (result.status === "fulfilled") {
      stats[scraper.key] = result.value.length;
      allRaw.push(...result.value);
    } else {
      log(`${scraper.name} failed: ${String(result.reason).slice(0, 100)}`);
    }
  }

  log(`Normalizing ${allRaw.length} raw listings...`);

  const existing = getExistingListingsMap();
  const normalized = normalize(allRaw, existing);
  stats.total = normalized.length;
  log(`${normalized.length} unique listings after deduplication`);

  const filtered = filterListings(normalized);
  stats.filtered = filtered.length;
  log(`${filtered.length} listings match filters (HW4 + non-black + 6-seat + clean title + no accidents)`);

  log("Saving to database...");
  upsertListings(normalized);

  const activeVins = new Set(normalized.map((l) => l.vin));
  markInactive(activeVins);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`Refresh complete in ${elapsed}s`);

  return stats;
}

// Run directly
if (import.meta.main) {
  refresh((msg) => {}).then((stats) => {
    console.log("\nSummary:", stats);
  });
}
