import { resolve } from "path";
import { getFilteredListings, getAllListings, excludeVin, unexcludeVin, getExcludedVins, setHw4Override, favoriteVin, unfavoriteVin, getFavorites } from "./db.ts";
import { refresh } from "../scripts/refresh.ts";

const PUBLIC_DIR = resolve(import.meta.dir, "../public");
const PORT = 3000;

let refreshInProgress = false;
let refreshLog: { time: number; msg: string; type: string }[] = [];
let refreshSeq = 0;

function logProgress(msg: string, type: string = "info") {
  refreshLog.push({ time: Date.now(), msg, type });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/listings") {
      const showAll = url.searchParams.get("all") === "true";
      const listings = showAll ? getAllListings() : getFilteredListings();
      return Response.json({
        listings,
        count: listings.length,
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

    // Source stats — always returns all 9 sources even if 0
    if (url.pathname === "/api/sources") {
      const ALL_SOURCES = ["marketcheck", "cars.com", "cargurus", "tesla", "truecar", "autotrader", "ebay", "edmunds", "carfax"];
      const all = getAllListings();
      const filtered = getFilteredListings();
      const allBySrc: Record<string, number> = {};
      const filtBySrc: Record<string, number> = {};
      for (const s of ALL_SOURCES) { allBySrc[s] = 0; filtBySrc[s] = 0; }
      for (const l of all) allBySrc[l.source] = (allBySrc[l.source] || 0) + 1;
      for (const l of filtered) filtBySrc[l.source] = (filtBySrc[l.source] || 0) + 1;
      return Response.json({ total: all.length, filtered: filtered.length, allBySrc, filtBySrc, sources: ALL_SOURCES });
    }

    if (url.pathname === "/api/refresh" && req.method === "POST") {
      if (refreshInProgress) {
        return Response.json(
          { error: "Refresh already in progress", inProgress: true },
          { status: 409 }
        );
      }

      let sources: string[] | undefined;
      try {
        const body = await req.json() as { sources?: string[] };
        if (Array.isArray(body.sources) && body.sources.length > 0) {
          sources = body.sources;
        }
      } catch { /* no body or invalid JSON — run all */ }

      refreshInProgress = true;
      refreshLog = [];
      refreshSeq++;
      const label = sources ? sources.join(", ") : "all sources";
      logProgress(`Starting data refresh (${label})...`);

      refresh((msg) => {
        logProgress(msg);
      }, sources)
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
