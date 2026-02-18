import { scrapeMarketCheck } from "../src/scraper/marketcheck.ts";
import { scrapeCarsCom } from "../src/scraper/cars-com.ts";
import { scrapeCarGurus } from "../src/scraper/cargurus.ts";
import { scrapeTesla } from "../src/scraper/tesla.ts";
import { scrapeTrueCar } from "../src/scraper/truecar.ts";
import { scrapeAutotrader } from "../src/scraper/autotrader.ts";
import { scrapeEbayMotors } from "../src/scraper/ebay-motors.ts";
import { scrapeEdmunds, scrapeEdmundsByVin } from "../src/scraper/edmunds.ts";
import { scrapeAutoDev } from "../src/scraper/auto-dev.ts";
import { normalize, filterListings } from "../src/normalize.ts";
import {
  upsertListings,
  markInactive,
  getExistingListingsMap,
  insertScraperLog,
  applyEnrichmentCache,
  applyListingOverrides,
} from "../src/db.ts";
import type { RawListing } from "../src/scraper/types.ts";

export type ProgressCallback = (msg: string) => void;
export type ScraperStatusCallback = (name: string, status: ScraperStatus) => void;

export interface ScraperStatus {
  status: "pending" | "running" | "done" | "timeout" | "error";
  count: number;
  startedAt: number;
  finishedAt?: number;
  message?: string;
}

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
  fn: (onProgress?: ProgressCallback, onPartialResults?: (batch: RawListing[]) => void) => Promise<RawListing[]>;
  timeout: number; // ms — per-scraper timeout ceiling
}

const SCRAPERS: ScraperDef[] = [
  { name: "Tesla Inventory", key: "tesla", fn: scrapeTesla, timeout: 180_000 },
  { name: "MarketCheck", key: "marketcheck", fn: scrapeMarketCheck, timeout: 30_000 },
  { name: "Auto.dev", key: "autoDev", fn: scrapeAutoDev, timeout: 180_000 },
  { name: "Autotrader", key: "autotrader", fn: scrapeAutotrader, timeout: 180_000 },
  { name: "TrueCar", key: "truecar", fn: scrapeTrueCar, timeout: 60_000 },
  { name: "Edmunds", key: "edmunds", fn: scrapeEdmunds, timeout: 180_000 },
  { name: "eBay Motors", key: "ebay", fn: scrapeEbayMotors, timeout: 30_000 },
  { name: "Cars.com", key: "carsCom", fn: scrapeCarsCom, timeout: 60_000 },
  { name: "CarGurus", key: "carGurus", fn: scrapeCarGurus, timeout: 30_000 },
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
  onlySources?: string[],
  onScraperStatus?: ScraperStatusCallback,
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

  // Initialize scraper status
  for (const s of activescrapers) {
    log(`Fetching from ${s.name}...`);
    onScraperStatus?.(s.name, { status: "pending", count: 0, startedAt: Date.now() });
  }

  // Run scrapers with per-source timing and per-scraper timeout

  // Shared mutable array pattern: each scraper pushes results incrementally.
  // On timeout, withTimeout returns whatever partial results have been collected.
  function withTimeout(
    runScraper: (partialResults: RawListing[]) => Promise<RawListing[]>,
    name: string,
    ms: number,
  ): Promise<{ results: RawListing[]; timedOut: boolean; endMs: number }> {
    const partialResults: RawListing[] = [];
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const endMs = Date.now();
          log(`[${name}] Timed out after ${ms / 1000}s — returning ${partialResults.length} partial results`);
          onScraperStatus?.(name, { status: "timeout", count: partialResults.length, startedAt: 0, finishedAt: endMs, message: `Timed out after ${ms / 1000}s` });
          resolve({ results: [...partialResults], timedOut: true, endMs });
        }
      }, ms);
      runScraper(partialResults).then(
        (val) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const endMs = Date.now();
            onScraperStatus?.(name, { status: "done", count: val.length, startedAt: 0, finishedAt: endMs });
            resolve({ results: val, timedOut: false, endMs });
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const endMs = Date.now();
            log(`[${name}] Error: ${String(err).slice(0, 200)}`);
            onScraperStatus?.(name, { status: "error", count: partialResults.length, startedAt: 0, finishedAt: endMs, message: String(err).slice(0, 200) });
            resolve({ results: [...partialResults], timedOut: false, endMs });
          }
        },
      );
    });
  }

  const scraperTimings: { scraper: ScraperDef; startMs: number }[] =
    activescrapers.map((s) => ({ scraper: s, startMs: Date.now() }));

  const results = await Promise.allSettled(
    scraperTimings.map(({ scraper }) => {
      onScraperStatus?.(scraper.name, { status: "running", count: 0, startedAt: Date.now() });
      return withTimeout(
        async (partialResults) => {
          const r = await scraper.fn(
            (msg) => {
              log(msg);
              onScraperStatus?.(scraper.name, { status: "running", count: partialResults.length, startedAt: 0, message: msg });
            },
            (batch) => {
              // Push streaming results into shared array as they arrive (timeout safety)
              partialResults.push(...batch);
              onScraperStatus?.(scraper.name, { status: "running", count: partialResults.length, startedAt: 0 });
            },
          );
          // Push remaining results that weren't streamed (fetch-based scrapers)
          if (partialResults.length === 0) {
            partialResults.push(...r);
          }
          log(`${scraper.name}: ${r.length} listings found`);
          return r;
        },
        scraper.name,
        scraper.timeout,
      );
    })
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
  const rawByScraper: { scraper: ScraperDef; raw: RawListing[]; durationMs: number; status: "success" | "timeout" | "error"; error?: string }[] = [];

  for (let i = 0; i < scraperTimings.length; i++) {
    const result = results[i]!;
    const { scraper, startMs } = scraperTimings[i]!;

    if (result.status === "fulfilled") {
      const { results: scraperResults, timedOut, endMs } = result.value;
      const durationMs = endMs - startMs;
      stats[scraper.key] = scraperResults.length;
      allRaw.push(...scraperResults);
      rawByScraper.push({
        scraper,
        raw: scraperResults,
        durationMs,
        status: timedOut ? "timeout" : "success",
      });
    } else {
      const durationMs = Date.now() - startMs;
      const errMsg = String(result.reason).slice(0, 500);
      log(`${scraper.name} failed: ${errMsg.slice(0, 100)}`);
      rawByScraper.push({ scraper, raw: [], durationMs, status: "error", error: errMsg });
    }
  }

  log(`Normalizing ${allRaw.length} raw listings...`);

  const existing = getExistingListingsMap();
  const normalized = await normalize(allRaw, existing);
  stats.total = normalized.length;
  log(`${normalized.length} unique listings after deduplication`);

  const filtered = filterListings(normalized);
  stats.filtered = filtered.length;
  log(`${filtered.length} listings match filters (HW4 + 6-seat + clean title + no accidents)`);

  log("Saving to database...");
  upsertListings(normalized);

  // Mark vehicles no longer found by any scraper as inactive (sold/delisted).
  // Only on full refreshes — partial refreshes shouldn't deactivate other sources' VINs.
  if (!onlySources || onlySources.length === 0) {
    const activeVins = new Set(normalized.map((l) => l.vin));
    markInactive(activeVins);
    log(`Marked inactive: VINs not in current ${activeVins.size} results`);
  }

  // Fill blanks from cached enrichment data (dealer site data)
  applyEnrichmentCache();

  // Re-apply manual field overrides (user edits persist across refreshes)
  applyListingOverrides();

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
      status: entry.status,
      rawCount: entry.raw.length,
      dedupedCount: dedupBySource[sourceName] || 0,
      filteredCount: filtBySource[sourceName] || 0,
      errorMessage: entry.error || (entry.status === "timeout" ? `Timed out after ${entry.scraper.timeout / 1000}s` : null),
      durationMs: entry.durationMs,
      timestamp: ts,
    });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`Refresh complete in ${elapsed}s`);

  return stats;
}

/**
 * Per-VIN re-scrape: fetches fresh data for specific VINs without running
 * the full paginated scrapers. For Edmunds, uses curl on VDP pages (fast).
 * For other sources, falls back to running the full scraper and filtering.
 */
export async function refreshVins(
  vins: { vin: string; year: number; source: string }[],
  onProgress?: ProgressCallback
): Promise<number> {
  const log = (msg: string) => {
    console.log(msg);
    onProgress?.(msg);
  };

  // Group VINs by source key
  const bySource = new Map<string, { vin: string; year: number }[]>();
  for (const v of vins) {
    const key = SOURCE_KEY_MAP[v.source.toLowerCase()] ?? v.source.toLowerCase();
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push({ vin: v.vin, year: v.year });
  }

  const allRaw: RawListing[] = [];

  for (const [sourceKey, sourceVins] of bySource) {
    if (sourceKey === "edmunds") {
      // Per-VIN Edmunds scrape via curl (fast — no browser needed)
      for (const { vin, year } of sourceVins) {
        log(`[Edmunds] Re-scraping VIN ${vin}...`);
        try {
          const result = await scrapeEdmundsByVin(vin, year);
          if (result) {
            allRaw.push(result);
            log(`[Edmunds] Got data for ${vin}`);
          } else {
            log(`[Edmunds] No data for ${vin} (blocked or not found)`);
          }
        } catch (err) {
          log(`[Edmunds] Error for ${vin}: ${err}`);
        }
      }
    } else {
      // For other sources, run the full scraper and filter to requested VINs
      const scraper = SCRAPERS.find((s) => s.key === sourceKey);
      if (!scraper) {
        log(`Unknown source: ${sourceKey}`);
        continue;
      }
      log(`[${scraper.name}] Running scraper for ${sourceVins.length} VIN(s)...`);
      try {
        const results = await scraper.fn(log);
        const vinSet = new Set(sourceVins.map((v) => v.vin.toUpperCase()));
        const matched = results.filter((r) => vinSet.has(r.vin.toUpperCase()));
        allRaw.push(...matched);
        log(
          `[${scraper.name}] Found ${matched.length}/${sourceVins.length} requested VIN(s)`
        );
      } catch (err) {
        log(`[${scraper.name}] Error: ${err}`);
      }
    }
  }

  if (allRaw.length === 0) {
    log("No results to update.");
    return 0;
  }

  // Normalize and upsert
  const existing = getExistingListingsMap();
  const normalized = await normalize(allRaw, existing);
  log(`Upserting ${normalized.length} listing(s)...`);
  upsertListings(normalized);
  applyEnrichmentCache();
  applyListingOverrides();

  return normalized.length;
}

// Run directly
if (import.meta.main) {
  refresh((msg) => {}).then((stats) => {
    console.log("\nSummary:", stats);
  });
}
