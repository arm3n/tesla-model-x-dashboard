import { scrapeMarketCheck } from "../src/scraper/marketcheck.ts";
import { scrapeCarsCom } from "../src/scraper/cars-com.ts";
import { scrapeCarGurus } from "../src/scraper/cargurus.ts";
import { scrapeTesla } from "../src/scraper/tesla.ts";
import { scrapeTrueCar } from "../src/scraper/truecar.ts";
import { scrapeAutotrader } from "../src/scraper/autotrader.ts";
import { scrapeEbayMotors } from "../src/scraper/ebay-motors.ts";
import { scrapeEdmunds } from "../src/scraper/edmunds.ts";
import { scrapeAutoDev } from "../src/scraper/auto-dev.ts";
import { normalize, filterListings } from "../src/normalize.ts";
import {
  upsertListings,
  getExistingListingsMap,
  insertScraperLog,
} from "../src/db.ts";
import type { RawListing } from "../src/scraper/types.ts";

export type ProgressCallback = (msg: string) => void;

export interface RefreshStats {
  marketcheck: number;
  autoDev: number;
  tesla: number;
  autotrader: number;
  truecar: number;
  edmunds: number;
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
  { name: "Auto.dev", key: "autoDev", fn: scrapeAutoDev },
  { name: "Autotrader", key: "autotrader", fn: scrapeAutotrader },
  { name: "TrueCar", key: "truecar", fn: scrapeTrueCar },
  { name: "Edmunds", key: "edmunds", fn: scrapeEdmunds },
  { name: "eBay Motors", key: "ebay", fn: scrapeEbayMotors },
  { name: "Cars.com", key: "carsCom", fn: scrapeCarsCom },
  { name: "CarGurus", key: "carGurus", fn: scrapeCarGurus },
];

/** Map from source key/name to the scraper key used in SCRAPERS */
const SOURCE_KEY_MAP: Record<string, string> = {
  marketcheck: "marketcheck",
  "auto.dev": "autoDev",
  autodev: "autoDev",
  "cars.com": "carsCom",
  carscom: "carsCom",
  cargurus: "carGurus",
  tesla: "tesla",
  truecar: "truecar",
  autotrader: "autotrader",
  ebay: "ebay",
  edmunds: "edmunds",
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

  const refreshId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (const s of activescrapers) {
    log(`Fetching from ${s.name}...`);
  }

  // Run scrapers with per-source timing
  const scraperTimings: { scraper: ScraperDef; startMs: number }[] =
    activescrapers.map((s) => ({ scraper: s, startMs: Date.now() }));

  const results = await Promise.allSettled(
    scraperTimings.map(({ scraper }) =>
      scraper.fn().then((r) => {
        log(`${scraper.name}: ${r.length} listings found`);
        return r;
      })
    )
  );

  const stats: RefreshStats = {
    marketcheck: 0,
    autoDev: 0,
    tesla: 0,
    autotrader: 0,
    truecar: 0,
    edmunds: 0,
    ebay: 0,
    carsCom: 0,
    carGurus: 0,
    total: 0,
    filtered: 0,
  };

  const allRaw: RawListing[] = [];
  const rawByScraper: { scraper: ScraperDef; raw: RawListing[]; durationMs: number; error?: string }[] = [];

  const now = Date.now();
  for (let i = 0; i < scraperTimings.length; i++) {
    const result = results[i]!;
    const { scraper, startMs } = scraperTimings[i]!;
    const durationMs = now - startMs;

    if (result.status === "fulfilled") {
      stats[scraper.key] = result.value.length;
      allRaw.push(...result.value);
      rawByScraper.push({ scraper, raw: result.value, durationMs });
    } else {
      const errMsg = String(result.reason).slice(0, 500);
      log(`${scraper.name} failed: ${errMsg.slice(0, 100)}`);
      rawByScraper.push({ scraper, raw: [], durationMs, error: errMsg });
    }
  }

  log(`Normalizing ${allRaw.length} raw listings...`);

  const existing = getExistingListingsMap();
  const normalized = await normalize(allRaw, existing);
  stats.total = normalized.length;
  log(`${normalized.length} unique listings after deduplication`);

  const filtered = filterListings(normalized);
  stats.filtered = filtered.length;
  log(`${filtered.length} listings match filters (HW4 + non-black + 6-seat + clean title + no accidents)`);

  log("Saving to database...");
  upsertListings(normalized);

  // Build per-source dedup/filter counts from normalized results
  const SOURCE_NAME_MAP: Record<string, string> = {
    tesla: "tesla", marketcheck: "marketcheck", autoDev: "auto.dev",
    autotrader: "autotrader", truecar: "truecar", edmunds: "edmunds",
    ebay: "ebay", carsCom: "cars.com", carGurus: "cargurus",
  };

  const dedupBySource: Record<string, number> = {};
  const filtBySource: Record<string, number> = {};
  for (const l of normalized) dedupBySource[l.source] = (dedupBySource[l.source] || 0) + 1;
  for (const l of filtered) filtBySource[l.source] = (filtBySource[l.source] || 0) + 1;

  // Write scraper logs
  const ts = new Date().toISOString();
  for (const entry of rawByScraper) {
    const sourceName = SOURCE_NAME_MAP[entry.scraper.key] || entry.scraper.key;
    insertScraperLog({
      refreshId,
      source: entry.scraper.name,
      status: entry.error ? "error" : "success",
      rawCount: entry.raw.length,
      dedupedCount: dedupBySource[sourceName] || 0,
      filteredCount: filtBySource[sourceName] || 0,
      errorMessage: entry.error || null,
      durationMs: entry.durationMs,
      timestamp: ts,
    });
  }

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
