import { resolve } from "path";
import { getFilteredListings, getAllListings, excludeVin, unexcludeVin, getExcludedVins, setHw4Override, setUrlOverride, removeUrlOverride, getUrlOverrides, favoriteVin, unfavoriteVin, getFavorites, getScraperLogs, insertScraperLog, updateListingFields, removeListingOverrides, getListingOverrides, purgeNonPlaid, markPossiblySold } from "./db.ts";
import { refresh, refreshVins } from "../scripts/refresh.ts";
import type { ScraperStatus } from "../scripts/refresh.ts";
import { runEnrichment, runEnrichmentForVins } from "./scraper/enrich.ts";

// Purge non-Plaid listings on startup
const purged = purgeNonPlaid();
if (purged > 0) console.log(`[startup] Purged ${purged} non-Plaid listings from DB`);

const PUBLIC_DIR = resolve(import.meta.dir, "../public");
const PORT = parseInt(process.env.PORT || "3000", 10);

let refreshInProgress = false;
let refreshLog: { time: number; msg: string; type: string }[] = [];
let refreshSeq = 0;
let scraperStatuses: Record<string, ScraperStatus> = {};

// SSE: connected clients
const sseClients = new Set<ReadableStreamDefaultController>();

function sseEmit(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const ctrl of sseClients) {
    try { ctrl.enqueue(payload); } catch { sseClients.delete(ctrl); }
  }
}

function logProgress(msg: string, type: string = "info") {
  const entry = { time: Date.now(), msg, type };
  refreshLog.push(entry);
  sseEmit("progress", entry);
}

function updateScraperStatus(name: string, status: ScraperStatus) {
  // Preserve startedAt from initial "running" update
  const existing = scraperStatuses[name];
  if (existing && status.startedAt === 0) {
    status.startedAt = existing.startedAt;
  }
  scraperStatuses[name] = status;
  sseEmit("scraper", { name, status });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/listings") {
      const showAll = url.searchParams.get("all") === "true";
      const listings = showAll ? getAllListings() : getFilteredListings();
      const enrichedListings = listings.map(l => {
        // Build _enriched from JOIN columns (no separate getEnrichmentMap call)
        const fields: string[] = [];
        const values: Record<string, any> = {};
        if (l.e_price != null && l.e_price > 0) { fields.push('price'); values.price = l.e_price; }
        if (l.e_mileage != null && l.e_mileage > 0) { fields.push('mileage'); values.mileage = l.e_mileage; }
        if (l.e_interiorColor != null && l.e_interiorColor !== '') { fields.push('interiorColor'); values.interiorColor = l.e_interiorColor; }
        if (l.e_exteriorColor != null && l.e_exteriorColor !== '') { fields.push('exteriorColor'); values.exteriorColor = l.e_exteriorColor; }
        if (l.e_imageUrl != null && l.e_imageUrl !== '') { fields.push('imageUrl'); values.imageUrl = l.e_imageUrl; }

        // Strip enrichment columns from the listing payload
        const { e_price, e_mileage, e_interiorColor, e_exteriorColor, e_imageUrl, e_dealerUrl, e_searchedAt, ...clean } = l;

        return {
          ...clean,
          _enriched: fields.length > 0
            ? { fields, values, dealerUrl: e_dealerUrl || null, searchedAt: e_searchedAt || null }
            : null,
        };
      });
      return Response.json({
        listings: enrichedListings,
        count: enrichedListings.length,
        timestamp: new Date().toISOString(),
      });
    }

    // Poll-based progress endpoint (legacy)
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

    // SSE stream for live refresh progress
    if (url.pathname === "/api/refresh/stream") {
      const stream = new ReadableStream({
        start(controller) {
          sseClients.add(controller);
          // Send current state on connect
          controller.enqueue(`event: init\ndata: ${JSON.stringify({
            inProgress: refreshInProgress,
            scrapers: scraperStatuses,
          })}\n\n`);
        },
        cancel(controller) {
          sseClients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
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
      refreshLog = [];
      refreshSeq++;
      scraperStatuses = {};

      const enrichId = `enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startMs = Date.now();
      logProgress("Starting VIN enrichment...");
      updateScraperStatus("Enrichment", { status: "running", count: 0, startedAt: startMs });

      runEnrichment((msg) => {
        logProgress(msg);
        // Parse enrichment progress from messages like "[enrich] VIN: enriched ..."
        const enrichedMatch = msg.match(/enriched \(([^)]+)\)/);
        if (enrichedMatch) {
          const current = (scraperStatuses["Enrichment"]?.count || 0) + 1;
          updateScraperStatus("Enrichment", { status: "running", count: current, startedAt: startMs, message: msg });
        }
      })
        .then((result) => {
          updateScraperStatus("Enrichment", { status: "done", count: result.enriched, startedAt: startMs, finishedAt: Date.now() });
          logProgress(`Enrichment done: ${result.enriched} enriched of ${result.candidates} candidates`, "done");
          // Build per-VIN detail summary for the log
          const detailStr = result.details.length > 0
            ? result.details.map(d => `${d.vin}: ${d.fields.join(', ')}${d.dealerUrl ? ' (' + d.dealerUrl + ')' : ''}`).join('; ')
            : null;
          insertScraperLog({
            refreshId: enrichId,
            source: "Enrichment",
            status: "success",
            rawCount: result.candidates,
            dedupedCount: result.searched,
            filteredCount: result.enriched,
            errorMessage: detailStr,
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            type: "enrich",
          });
        })
        .catch((err) => {
          updateScraperStatus("Enrichment", { status: "error", count: 0, startedAt: startMs, finishedAt: Date.now(), message: String(err).slice(0, 200) });
          logProgress("Enrichment error: " + String(err), "error");
          insertScraperLog({
            refreshId: enrichId,
            source: "Enrichment",
            status: "error",
            rawCount: 0,
            dedupedCount: 0,
            filteredCount: 0,
            errorMessage: String(err).slice(0, 500),
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            type: "enrich",
          });
        })
        .finally(() => {
          refreshInProgress = false;
          sseEmit("done", { inProgress: false });
        });

      return Response.json({ success: true, message: "Enrichment started" });
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
      refreshLog = [];
      refreshSeq++;
      scraperStatuses = {};

      const enrichId = `enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startMs = Date.now();
      const vinCount = body.vins.length;
      logProgress(`Starting targeted enrichment for ${vinCount} VINs...`);
      updateScraperStatus("Enrichment", { status: "running", count: 0, startedAt: startMs });

      runEnrichmentForVins(body.vins, (msg) => {
        logProgress(msg);
        const enrichedMatch = msg.match(/enriched \(([^)]+)\)/);
        if (enrichedMatch) {
          const current = (scraperStatuses["Enrichment"]?.count || 0) + 1;
          updateScraperStatus("Enrichment", { status: "running", count: current, startedAt: startMs, message: msg });
        }
      })
        .then((result) => {
          updateScraperStatus("Enrichment", { status: "done", count: result.enriched, startedAt: startMs, finishedAt: Date.now() });
          logProgress(`Targeted enrichment done: ${result.enriched} enriched of ${result.candidates} VINs`, "done");
          const detailStr = result.details.length > 0
            ? result.details.map(d => `${d.vin}: ${d.fields.join(', ')}${d.dealerUrl ? ' (' + d.dealerUrl + ')' : ''}`).join('; ')
            : null;
          insertScraperLog({
            refreshId: enrichId,
            source: "Enrichment",
            status: "success",
            rawCount: result.candidates,
            dedupedCount: result.searched,
            filteredCount: result.enriched,
            errorMessage: detailStr,
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            type: "enrich",
          });
        })
        .catch((err) => {
          updateScraperStatus("Enrichment", { status: "error", count: 0, startedAt: startMs, finishedAt: Date.now(), message: String(err).slice(0, 200) });
          logProgress("Enrichment error: " + String(err), "error");
          insertScraperLog({
            refreshId: enrichId,
            source: "Enrichment",
            status: "error",
            rawCount: 0,
            dedupedCount: 0,
            filteredCount: 0,
            errorMessage: String(err).slice(0, 500),
            durationMs: Date.now() - startMs,
            timestamp: new Date().toISOString(),
            type: "enrich",
          });
        })
        .finally(() => {
          refreshInProgress = false;
          sseEmit("done", { inProgress: false });
        });

      return Response.json({ success: true, message: "Enrichment started" });
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

        refreshVins(vins, (msg) => logProgress(msg), updateScraperStatus)
          .then(async (result) => {
            if (result.missing.length === 0) {
              logProgress(`Done! Re-scraped ${result.updated} listing(s)`, "done");
              return;
            }

            // Auto-enrich missing VINs — verify against dealer sites before marking sold
            const autoEnrichId = `auto-enrich-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const autoEnrichStart = Date.now();
            logProgress(`${result.missing.length} VIN(s) not found by scraper — checking dealer sites...`);
            try {
              const enrichResult = await runEnrichmentForVins(result.missing, (msg) => logProgress(msg));
              const enrichedVins = new Set(enrichResult.details.map(d => d.vin));
              const stillMissing = result.missing.filter(v => !enrichedVins.has(v));

              if (stillMissing.length > 0) {
                markPossiblySold(stillMissing);
                logProgress(`Marked ${stillMissing.length} VIN(s) as possibly sold: ${stillMissing.join(", ")}`);
              }
              if (enrichedVins.size > 0) {
                logProgress(`${enrichedVins.size} VIN(s) still found on dealer sites — updated data`);
              }

              // Write scraper log for the auto-enrich step
              const detailParts: string[] = [];
              for (const d of enrichResult.details) {
                detailParts.push(`${d.vin}: ${d.fields.join(", ")}${d.dealerUrl ? " (" + d.dealerUrl + ")" : ""}`);
              }
              if (stillMissing.length > 0) {
                detailParts.push(`POSSIBLY SOLD: ${stillMissing.join(", ")}`);
              }
              insertScraperLog({
                refreshId: autoEnrichId,
                source: "Auto-Enrich (sold check)",
                status: "success",
                rawCount: result.missing.length,
                dedupedCount: enrichResult.searched,
                filteredCount: enrichResult.enriched,
                errorMessage: detailParts.length > 0 ? detailParts.join("; ") : null,
                durationMs: Date.now() - autoEnrichStart,
                timestamp: new Date().toISOString(),
                type: "enrich",
              });

              let msg = `Done! Re-scraped ${result.updated} listing(s)`;
              if (stillMissing.length > 0) {
                msg += ` — ${stillMissing.length} possibly sold`;
              }
              logProgress(msg, "done");
            } catch (err) {
              // Enrichment failed — still mark as possibly sold based on scraper miss alone
              markPossiblySold(result.missing);
              insertScraperLog({
                refreshId: autoEnrichId,
                source: "Auto-Enrich (sold check)",
                status: "error",
                rawCount: result.missing.length,
                dedupedCount: 0,
                filteredCount: 0,
                errorMessage: `Failed: ${String(err).slice(0, 300)}; marked ${result.missing.length} VIN(s) as possibly sold`,
                durationMs: Date.now() - autoEnrichStart,
                timestamp: new Date().toISOString(),
                type: "enrich",
              });
              logProgress(`Enrichment check failed (${String(err).slice(0, 100)}) — marked ${result.missing.length} VIN(s) as possibly sold`, "done");
            }
          })
          .catch((err) => {
            logProgress("Error: " + String(err), "error");
          })
          .finally(() => {
            refreshInProgress = false;
          sseEmit("done", { inProgress: false });
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
          sseEmit("done", { inProgress: false });
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
