import { resolve } from "path";
import { getFilteredListings, getAllListings, excludeVin, unexcludeVin, getExcludedVins, setHw4Override, setUrlOverride, removeUrlOverride, getUrlOverrides, favoriteVin, unfavoriteVin, getFavorites, getScraperLogs, updateListingFields, removeListingOverrides, getListingOverrides, getEnrichmentMap } from "./db.ts";
import { refresh, refreshVins } from "../scripts/refresh.ts";
import type { ScraperStatus } from "../scripts/refresh.ts";
import { runEnrichment, runEnrichmentForVins } from "./scraper/enrich.ts";

const PUBLIC_DIR = resolve(import.meta.dir, "../public");
const PORT = parseInt(process.env.PORT || "3000", 10);

let refreshInProgress = false;
let refreshLog: { time: number; msg: string; type: string }[] = [];
let refreshSeq = 0;
let scraperStatuses: Record<string, ScraperStatus> = {};

function logProgress(msg: string, type: string = "info") {
  refreshLog.push({ time: Date.now(), msg, type });
}

function updateScraperStatus(name: string, status: ScraperStatus) {
  // Preserve startedAt from initial "running" update
  const existing = scraperStatuses[name];
  if (existing && status.startedAt === 0) {
    status.startedAt = existing.startedAt;
  }
  scraperStatuses[name] = status;
}

const server = Bun.serve({
  port: PORT,
  reusePort: true,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/listings") {
      const showAll = url.searchParams.get("all") === "true";
      const listings = showAll ? getAllListings() : getFilteredListings();
      const enrichmentMap = getEnrichmentMap();
      const enrichedListings = listings.map(l => {
        const enrichment = enrichmentMap.get(l.vin);
        return {
          ...l,
          _enriched: enrichment && enrichment.fields.length > 0
            ? { fields: enrichment.fields, dealerUrl: enrichment.dealerUrl, searchedAt: enrichment.searchedAt }
            : null,
        };
      });
      return Response.json({
        listings: enrichedListings,
        count: enrichedListings.length,
        timestamp: new Date().toISOString(),
      });
    }

    // Poll-based progress endpoint
    if (url.pathname === "/api/refresh/progress") {
      const since = parseInt(url.searchParams.get("since") ?? "0", 10);
      const newEntries = refreshLog.filter((e) => e.time > since);
      return Response.json({
        inProgress: refreshInProgress,
        seq: refreshSeq,
        entries: newEntries,
        scrapers: scraperStatuses,
      });
    }

    // Exclude a VIN
    if (url.pathname === "/api/exclude" && req.method === "POST") {
      const body = await req.json() as { vin?: string; reason?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      excludeVin(body.vin, body.reason ?? "");
      return Response.json({ success: true, vin: body.vin });
    }

    // Unexclude a VIN
    if (url.pathname === "/api/exclude" && req.method === "DELETE") {
      const body = await req.json() as { vin?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      unexcludeVin(body.vin);
      return Response.json({ success: true, vin: body.vin });
    }

    // List excluded VINs
    if (url.pathname === "/api/excluded") {
      return Response.json({ excluded: getExcludedVins() });
    }

    // Toggle HW4 status
    if (url.pathname === "/api/hw4" && req.method === "POST") {
      const body = await req.json() as { vin?: string; hw4Status?: string };
      if (!body.vin || !body.hw4Status) {
        return Response.json({ error: "vin and hw4Status required" }, { status: 400 });
      }
      const valid = ["confirmed", "likely", "uncertain", "ask dealer", "no"];
      if (!valid.includes(body.hw4Status)) {
        return Response.json({ error: "hw4Status must be one of: " + valid.join(", ") }, { status: 400 });
      }
      setHw4Override(body.vin, body.hw4Status);
      return Response.json({ success: true, vin: body.vin, hw4Status: body.hw4Status });
    }

    // Set URL override
    if (url.pathname === "/api/url-override" && req.method === "POST") {
      const body = await req.json() as { vin?: string; url?: string };
      if (!body.vin || !body.url) {
        return Response.json({ error: "vin and url required" }, { status: 400 });
      }
      setUrlOverride(body.vin, body.url);
      return Response.json({ success: true, vin: body.vin, url: body.url });
    }

    // Remove URL override
    if (url.pathname === "/api/url-override" && req.method === "DELETE") {
      const body = await req.json() as { vin?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      removeUrlOverride(body.vin);
      return Response.json({ success: true, vin: body.vin });
    }

    // List URL overrides
    if (url.pathname === "/api/url-overrides") {
      return Response.json({ overrides: getUrlOverrides() });
    }

    // Favorite a VIN
    if (url.pathname === "/api/favorite" && req.method === "POST") {
      const body = await req.json() as { vin?: string; note?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      favoriteVin(body.vin, body.note ?? "");
      return Response.json({ success: true, vin: body.vin });
    }

    // Unfavorite a VIN
    if (url.pathname === "/api/favorite" && req.method === "DELETE") {
      const body = await req.json() as { vin?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      unfavoriteVin(body.vin);
      return Response.json({ success: true, vin: body.vin });
    }

    // List favorites
    if (url.pathname === "/api/favorites") {
      return Response.json({ favorites: getFavorites() });
    }

    // Source stats — returns per-source raw counts from last full refresh
    if (url.pathname === "/api/sources") {
      const ALL_SOURCES = ["marketcheck", "auto.dev", "cars.com", "cargurus", "tesla", "truecar", "autotrader", "ebay", "edmunds"];
      const all = getAllListings();
      const filtered = getFilteredListings();

      // Map display names (scraper logs) → API source names
      const DISPLAY_TO_KEY: Record<string, string> = {
        "MarketCheck": "marketcheck", "Auto.dev": "auto.dev", "Cars.com": "cars.com",
        "CarGurus": "cargurus", "Tesla Inventory": "tesla", "TrueCar": "truecar",
        "Autotrader": "autotrader", "eBay Motors": "ebay", "Edmunds": "edmunds",
      };

      // Get latest full refresh from scraper logs (the one with the most sources)
      const logs = getScraperLogs(100);
      const byRefresh = new Map<string, typeof logs>();
      for (const l of logs) {
        if (!byRefresh.has(l.refreshId)) byRefresh.set(l.refreshId, []);
        byRefresh.get(l.refreshId)!.push(l);
      }
      // Find the most recent refresh with 5+ sources (full or near-full refresh)
      const rawBySrc: Record<string, number> = {};
      for (const s of ALL_SOURCES) rawBySrc[s] = 0;
      for (const [, entries] of byRefresh) {
        if (entries.length >= 5) {
          for (const e of entries) {
            const key = DISPLAY_TO_KEY[e.source] ?? e.source.toLowerCase();
            if (ALL_SOURCES.includes(key)) rawBySrc[key] = e.rawCount;
          }
          break;
        }
      }

      // DB source attribution (which source "owns" each VIN)
      const allBySrc: Record<string, number> = {};
      const filtBySrc: Record<string, number> = {};
      for (const s of ALL_SOURCES) { allBySrc[s] = 0; filtBySrc[s] = 0; }
      for (const l of all) allBySrc[l.source] = (allBySrc[l.source] || 0) + 1;
      for (const l of filtered) filtBySrc[l.source] = (filtBySrc[l.source] || 0) + 1;

      return Response.json({ total: all.length, filtered: filtered.length, allBySrc, filtBySrc, rawBySrc, sources: ALL_SOURCES });
    }

    // Edit listing fields
    if (url.pathname === "/api/listing" && req.method === "PATCH") {
      const body = await req.json() as { vin?: string; fields?: Record<string, any> };
      if (!body.vin || !body.fields || Object.keys(body.fields).length === 0) {
        return Response.json({ error: "vin and fields required" }, { status: 400 });
      }
      const allowed = new Set(['price', 'mileage', 'year', 'trim', 'exteriorColor', 'interiorColor', 'seatCount', 'dealerName', 'dealerLocation', 'titleStatus', 'accidentHistory', 'imageUrl']);
      const clean: Record<string, any> = {};
      for (const [k, v] of Object.entries(body.fields)) {
        if (allowed.has(k)) clean[k] = v;
      }
      if (Object.keys(clean).length === 0) {
        return Response.json({ error: "no valid fields provided" }, { status: 400 });
      }
      updateListingFields(body.vin, clean);
      return Response.json({ success: true, vin: body.vin, updated: Object.keys(clean) });
    }

    // Remove all listing overrides for a VIN
    if (url.pathname === "/api/listing-overrides" && req.method === "DELETE") {
      const body = await req.json() as { vin?: string };
      if (!body.vin) {
        return Response.json({ error: "vin required" }, { status: 400 });
      }
      removeListingOverrides(body.vin);
      return Response.json({ success: true, vin: body.vin });
    }

    // List all listing overrides
    if (url.pathname === "/api/listing-overrides") {
      return Response.json({ overrides: getListingOverrides() });
    }

    if (url.pathname === "/api/scraper-logs") {
      const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
      return Response.json({ logs: getScraperLogs(limit) });
    }

    // Trigger VIN enrichment (search dealer sites for missing data)
    if (url.pathname === "/api/enrich" && req.method === "POST") {
      if (refreshInProgress) {
        return Response.json({ error: "Refresh in progress, try after it completes" }, { status: 409 });
      }
      refreshInProgress = true;
      logProgress("Starting VIN enrichment...");
      try {
        const result = await runEnrichment((msg) => logProgress(msg));
        logProgress(`Enrichment done: ${result.enriched} enriched of ${result.candidates} candidates`, "done");
        return Response.json({ success: true, ...result });
      } catch (err) {
        logProgress("Enrichment error: " + String(err), "error");
        return Response.json({ error: String(err) }, { status: 500 });
      } finally {
        refreshInProgress = false;
      }
    }

    // Targeted VIN enrichment (re-enrich specific VINs)
    if (url.pathname === "/api/enrich-vins" && req.method === "POST") {
      if (refreshInProgress) {
        return Response.json({ error: "Refresh in progress, try after it completes" }, { status: 409 });
      }
      const body = await req.json() as { vins?: string[] };
      if (!body.vins || !Array.isArray(body.vins) || body.vins.length === 0) {
        return Response.json({ error: "vins array required" }, { status: 400 });
      }
      refreshInProgress = true;
      logProgress(`Starting targeted enrichment for ${body.vins.length} VINs...`);
      try {
        const result = await runEnrichmentForVins(body.vins, (msg) => logProgress(msg));
        logProgress(`Targeted enrichment done: ${result.enriched} enriched of ${result.candidates} VINs`, "done");
        return Response.json({ success: true, ...result });
      } catch (err) {
        logProgress("Enrichment error: " + String(err), "error");
        return Response.json({ error: String(err) }, { status: 500 });
      } finally {
        refreshInProgress = false;
      }
    }

    if (url.pathname === "/api/refresh" && req.method === "POST") {
      if (refreshInProgress) {
        return Response.json(
          { error: "Refresh already in progress", inProgress: true },
          { status: 409 }
        );
      }

      let sources: string[] | undefined;
      let vins: { vin: string; year: number; source: string }[] | undefined;
      try {
        const text = await req.text();
        if (text) {
          const body = JSON.parse(text) as {
            sources?: string[];
            vins?: { vin: string; year: number; source: string }[];
          };
          if (Array.isArray(body.vins) && body.vins.length > 0) {
            vins = body.vins;
          } else if (Array.isArray(body.sources) && body.sources.length > 0) {
            sources = body.sources;
          }
        }
      } catch (err) {
        console.error("[refresh] Failed to parse request body:", err);
      }

      refreshInProgress = true;
      refreshLog = [];
      refreshSeq++;
      scraperStatuses = {};

      if (vins) {
        // Per-VIN re-scrape mode (fast — skips full pagination)
        const label = `${vins.length} VIN(s)`;
        logProgress(`Re-scraping ${label}...`);

        refreshVins(vins, (msg) => logProgress(msg))
          .then((count) => {
            logProgress(`Done! Re-scraped ${count} listing(s)`, "done");
          })
          .catch((err) => {
            logProgress("Error: " + String(err), "error");
          })
          .finally(() => {
            refreshInProgress = false;
          });
      } else {
        // Full refresh mode
        const label = sources ? sources.join(", ") : "all sources";
        logProgress(`Starting data refresh (${label})...`);

        refresh((msg) => logProgress(msg), sources, updateScraperStatus)
          .then((stats) => {
            logProgress(
              `Done! ${stats.filtered} filtered listings (${stats.total} total)`,
              "done"
            );
          })
          .catch((err) => {
            logProgress("Error: " + String(err), "error");
          })
          .finally(() => {
            refreshInProgress = false;
          });
      }

      return Response.json({ success: true, message: "Refresh started" });
    }

    // Static files
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(resolve(PUBLIC_DIR, `.${filePath}`));

    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Dashboard running at http://localhost:${PORT}`);
