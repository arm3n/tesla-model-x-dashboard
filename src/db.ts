import { Database } from "bun:sqlite";
import type { Listing } from "./scraper/types.ts";
import { resolve } from "path";

const DB_PATH = resolve(import.meta.dir, "../data/listings.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      vin TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      price INTEGER NOT NULL,
      mileage INTEGER NOT NULL,
      year INTEGER NOT NULL,
      trim TEXT NOT NULL DEFAULT '',
      exteriorColor TEXT NOT NULL DEFAULT '',
      interiorColor TEXT NOT NULL DEFAULT '',
      seatCount INTEGER,
      hw4Status TEXT NOT NULL DEFAULT 'no',
      dealerName TEXT NOT NULL DEFAULT '',
      dealerLocation TEXT NOT NULL DEFAULT '',
      imageUrl TEXT,
      listedDate TEXT,
      firstSeen TEXT NOT NULL,
      lastSeen TEXT NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 1,
      titleStatus TEXT,
      accidentHistory TEXT NOT NULL DEFAULT 'unknown',
      completeness_score INTEGER NOT NULL DEFAULT 0,
      url_verified INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Migrate: add columns if missing (for existing DBs)
  try { _db.exec("ALTER TABLE listings ADD COLUMN titleStatus TEXT"); } catch {}
  try { _db.exec("ALTER TABLE listings ADD COLUMN accidentHistory TEXT NOT NULL DEFAULT 'unknown'"); } catch {}
  try { _db.exec("ALTER TABLE listings ADD COLUMN completeness_score INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { _db.exec("ALTER TABLE listings ADD COLUMN url_verified INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { _db.exec("ALTER TABLE listings ADD COLUMN possiblySold TEXT"); } catch {}

  _db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vin TEXT NOT NULL,
      price INTEGER NOT NULL,
      date TEXT NOT NULL,
      FOREIGN KEY (vin) REFERENCES listings(vin)
    )
  `);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_price_history_vin ON price_history(vin)
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS excluded_vins (
      vin TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      excludedAt TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      vin TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      favoritedAt TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS hw4_overrides (
      vin TEXT PRIMARY KEY,
      hw4Status TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS url_overrides (
      vin TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS listing_overrides (
      vin TEXT PRIMARY KEY,
      price INTEGER,
      mileage INTEGER,
      year INTEGER,
      trim TEXT,
      exteriorColor TEXT,
      interiorColor TEXT,
      seatCount INTEGER,
      dealerName TEXT,
      dealerLocation TEXT,
      titleStatus TEXT,
      accidentHistory TEXT,
      updatedAt TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS scraper_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refreshId TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      rawCount INTEGER NOT NULL DEFAULT 0,
      dedupedCount INTEGER NOT NULL DEFAULT 0,
      filteredCount INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT,
      durationMs INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scraper_logs_ts ON scraper_logs(timestamp)
  `);

  // Migration: add type column to scraper_logs (refresh/rescrape/enrich)
  try { _db.exec("ALTER TABLE scraper_logs ADD COLUMN type TEXT NOT NULL DEFAULT 'refresh'"); } catch {}

  _db.exec(`
    CREATE TABLE IF NOT EXISTS enrichment_cache (
      vin TEXT PRIMARY KEY,
      price INTEGER,
      mileage INTEGER,
      interiorColor TEXT,
      exteriorColor TEXT,
      dealerUrl TEXT,
      imageUrl TEXT,
      searchedAt TEXT NOT NULL
    )
  `);

  // Migration: add imageUrl column if missing (existing DBs)
  try {
    _db.exec(`ALTER TABLE enrichment_cache ADD COLUMN imageUrl TEXT`);
  } catch {}

  return _db;
}

export function upsertListings(listings: Listing[]): void {
  const db = getDb();

  // Source priority: lower = preferred. When a VIN already exists from a
  // higher-priority source, keep that source's core data (source, url,
  // price, dealer, etc.) and only update metadata (lastSeen, fill blanks).
  const SOURCE_PRIORITY_SQL = `
    CASE listings.source
      WHEN 'tesla' THEN 0
      WHEN 'marketcheck' THEN 1
      WHEN 'auto.dev' THEN 2
      WHEN 'autotrader' THEN 3
      WHEN 'cars.com' THEN 4
      WHEN 'truecar' THEN 5
      WHEN 'edmunds' THEN 6
      WHEN 'ebay' THEN 7
      WHEN 'cargurus' THEN 8
      ELSE 99
    END`;
  const NEW_PRIORITY_SQL = `
    CASE $source
      WHEN 'tesla' THEN 0
      WHEN 'marketcheck' THEN 1
      WHEN 'auto.dev' THEN 2
      WHEN 'autotrader' THEN 3
      WHEN 'cars.com' THEN 4
      WHEN 'truecar' THEN 5
      WHEN 'edmunds' THEN 6
      WHEN 'ebay' THEN 7
      WHEN 'cargurus' THEN 8
      ELSE 99
    END`;

  // "New wins" condition: new listing has higher completeness, OR same completeness but better source priority
  const NEW_WINS = `(
    $completenessScore > listings.completeness_score
    OR ($completenessScore = listings.completeness_score AND ${NEW_PRIORITY_SQL} <= ${SOURCE_PRIORITY_SQL})
  )`;

  const upsert = db.prepare(`
    INSERT INTO listings (
      vin, source, url, price, mileage, year, trim,
      exteriorColor, interiorColor, seatCount, hw4Status,
      dealerName, dealerLocation, imageUrl, listedDate,
      firstSeen, lastSeen, isActive, titleStatus, accidentHistory,
      completeness_score, url_verified
    ) VALUES (
      $vin, $source, $url, $price, $mileage, $year, $trim,
      $exteriorColor, $interiorColor, $seatCount, $hw4Status,
      $dealerName, $dealerLocation, $imageUrl, $listedDate,
      $firstSeen, $lastSeen, $isActive, $titleStatus, $accidentHistory,
      $completenessScore, $urlVerified
    )
    ON CONFLICT(vin) DO UPDATE SET
      source = CASE WHEN ${NEW_WINS} THEN $source ELSE listings.source END,
      url = CASE
        WHEN vin IN (SELECT vin FROM url_overrides) THEN (SELECT url FROM url_overrides WHERE url_overrides.vin = listings.vin)
        WHEN ${NEW_WINS} THEN $url
        ELSE listings.url END,
      price = CASE WHEN ${NEW_WINS} THEN $price ELSE listings.price END,
      mileage = CASE WHEN ${NEW_WINS} THEN $mileage ELSE listings.mileage END,
      year = CASE WHEN ${NEW_WINS} THEN $year ELSE listings.year END,
      trim = CASE WHEN ${NEW_WINS} THEN $trim ELSE listings.trim END,
      exteriorColor = CASE
        WHEN ${NEW_WINS} THEN $exteriorColor
        WHEN listings.exteriorColor = '' THEN $exteriorColor
        ELSE listings.exteriorColor END,
      interiorColor = CASE
        WHEN ${NEW_WINS} THEN $interiorColor
        WHEN listings.interiorColor = '' THEN $interiorColor
        ELSE listings.interiorColor END,
      seatCount = COALESCE(
        CASE WHEN ${NEW_WINS} THEN $seatCount ELSE listings.seatCount END,
        $seatCount, listings.seatCount),
      hw4Status = CASE
        WHEN vin IN (SELECT vin FROM hw4_overrides) THEN listings.hw4Status
        ELSE $hw4Status
      END,
      dealerName = CASE WHEN ${NEW_WINS} THEN $dealerName ELSE listings.dealerName END,
      dealerLocation = CASE WHEN ${NEW_WINS} THEN $dealerLocation ELSE listings.dealerLocation END,
      imageUrl = COALESCE(
        CASE WHEN ${NEW_WINS} THEN $imageUrl ELSE listings.imageUrl END,
        $imageUrl, listings.imageUrl),
      listedDate = COALESCE($listedDate, listings.listedDate),
      lastSeen = $lastSeen,
      isActive = $isActive,
      titleStatus = COALESCE($titleStatus, listings.titleStatus),
      accidentHistory = CASE
        WHEN $accidentHistory != 'unknown' THEN $accidentHistory
        ELSE COALESCE(listings.accidentHistory, 'unknown')
      END,
      completeness_score = CASE WHEN ${NEW_WINS} THEN $completenessScore ELSE listings.completeness_score END,
      url_verified = CASE WHEN ${NEW_WINS} THEN $urlVerified ELSE listings.url_verified END,
      possiblySold = NULL
  `);

  const insertPrice = db.prepare(`
    INSERT INTO price_history (vin, price, date) VALUES ($vin, $price, $date)
  `);

  const now = new Date().toISOString();

  // Bulk-fetch existing prices into a Map (eliminates N+1 SELECT per listing)
  const existingPrices = new Map<string, number>();
  const vins = listings.map(l => l.vin);
  for (let i = 0; i < vins.length; i += 500) {
    const chunk = vins.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT vin, price FROM listings WHERE vin IN (${placeholders})`).all(...chunk) as { vin: string; price: number }[];
    for (const r of rows) {
      existingPrices.set(r.vin, r.price);
    }
  }

  const transaction = db.transaction(() => {
    for (const listing of listings) {
      // Check if price changed (using pre-fetched Map instead of per-row SELECT)
      const existingPrice = existingPrices.get(listing.vin);
      if (existingPrice !== undefined && existingPrice !== listing.price) {
        insertPrice.run({
          $vin: listing.vin,
          $price: listing.price,
          $date: now,
        });
      }

      // Ensure all values are primitives (SQLite rejects objects/undefined)
      const s = (v: unknown): string =>
        v == null ? "" : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
      const sn = (v: unknown): string | null =>
        v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

      upsert.run({
        $vin: listing.vin,
        $source: s(listing.source),
        $url: s(listing.url),
        $price: listing.price || 0,
        $mileage: listing.mileage || 0,
        $year: listing.year || 0,
        $trim: s(listing.trim),
        $exteriorColor: s(listing.exteriorColor),
        $interiorColor: s(listing.interiorColor),
        $seatCount: listing.seatCount ?? null,
        $hw4Status: s(listing.hw4Status) || "no",
        $dealerName: s(listing.dealerName),
        $dealerLocation: s(listing.dealerLocation),
        $imageUrl: sn(listing.imageUrl),
        $listedDate: sn(listing.listedDate),
        $firstSeen: s(listing.firstSeen),
        $lastSeen: s(listing.lastSeen),
        $isActive: listing.isActive ? 1 : 0,
        $titleStatus: sn(listing.titleStatus),
        $accidentHistory: s(listing.accidentHistory) || "unknown",
        $completenessScore: listing.completenessScore ?? 0,
        $urlVerified: listing.urlVerified ? 1 : 0,
      });
    }
  });

  transaction();
}

export function markInactive(activeVins: Set<string>): void {
  const db = getDb();
  const allVins = db
    .prepare("SELECT vin FROM listings WHERE isActive = 1")
    .all() as { vin: string }[];

  const deactivate = db.prepare(
    "UPDATE listings SET isActive = 0 WHERE vin = $vin"
  );

  const transaction = db.transaction(() => {
    for (const row of allVins) {
      if (!activeVins.has(row.vin)) {
        deactivate.run({ $vin: row.vin });
      }
    }
  });

  transaction();
}

export function markPossiblySold(vins: string[]): void {
  if (vins.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < vins.length; i += 500) {
      const chunk = vins.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(`UPDATE listings SET possiblySold = ? WHERE vin IN (${placeholders}) AND possiblySold IS NULL`).run(now, ...chunk);
    }
  })();
}

export function clearPossiblySold(vins: string[]): void {
  if (vins.length === 0) return;
  const db = getDb();
  db.transaction(() => {
    for (let i = 0; i < vins.length; i += 500) {
      const chunk = vins.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(`UPDATE listings SET possiblySold = NULL WHERE vin IN (${placeholders})`).run(...chunk);
    }
  })();
}

export function getFilteredListings(): (Listing & { isFavorite: boolean; e_price: number | null; e_mileage: number | null; e_interiorColor: string | null; e_exteriorColor: string | null; e_imageUrl: string | null; e_dealerUrl: string | null; e_searchedAt: string | null })[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT l.*,
      CASE WHEN f.vin IS NOT NULL THEN 1 ELSE 0 END AS isFavorite,
      e.price AS e_price, e.mileage AS e_mileage,
      e.interiorColor AS e_interiorColor, e.exteriorColor AS e_exteriorColor,
      e.imageUrl AS e_imageUrl, e.dealerUrl AS e_dealerUrl, e.searchedAt AS e_searchedAt
    FROM listings l
    LEFT JOIN favorites f ON l.vin = f.vin
    LEFT JOIN enrichment_cache e ON l.vin = e.vin
    WHERE l.isActive = 1
      AND l.vin NOT IN (SELECT vin FROM excluded_vins)
      AND l.hw4Status IN ('confirmed', 'likely', 'uncertain', 'ask dealer')
      AND (l.interiorColor IS NULL OR LOWER(l.interiorColor) LIKE '%white%'
           OR LOWER(l.interiorColor) NOT LIKE '%black%')
      AND (l.seatCount = 6 OR l.seatCount IS NULL)
      AND (l.trim = 'Plaid' OR l.trim IS NULL OR l.trim = '')
      AND l.price <= 85000
      AND (l.titleStatus IS NULL OR LOWER(l.titleStatus) NOT IN ('salvage', 'rebuilt', 'flood', 'lemon', 'junk', 'branded'))
      AND l.accidentHistory != 'accident'
      AND l.mileage <= 50000
    ORDER BY isFavorite DESC, l.price ASC
  `
    )
    .all() as any[];

  return rows.map((r: any) => ({ ...r, isActive: r.isActive === 1, isFavorite: r.isFavorite === 1 }));
}

export function getAllListings(): (Listing & { isFavorite: boolean; e_price: number | null; e_mileage: number | null; e_interiorColor: string | null; e_exteriorColor: string | null; e_imageUrl: string | null; e_dealerUrl: string | null; e_searchedAt: string | null })[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT l.*,
        CASE WHEN f.vin IS NOT NULL THEN 1 ELSE 0 END AS isFavorite,
        e.price AS e_price, e.mileage AS e_mileage,
        e.interiorColor AS e_interiorColor, e.exteriorColor AS e_exteriorColor,
        e.imageUrl AS e_imageUrl, e.dealerUrl AS e_dealerUrl, e.searchedAt AS e_searchedAt
      FROM listings l
      LEFT JOIN favorites f ON l.vin = f.vin
      LEFT JOIN enrichment_cache e ON l.vin = e.vin
      WHERE l.isActive = 1
      ORDER BY isFavorite DESC, l.price ASC
    `)
    .all() as any[];
  return rows.map((r: any) => ({ ...r, isActive: r.isActive === 1, isFavorite: r.isFavorite === 1 }));
}

export function getExistingListingsMap(): Map<string, Listing> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM listings").all() as (Listing & {
    isActive: number;
  })[];
  const map = new Map<string, Listing>();
  for (const r of rows) {
    map.set(r.vin, { ...r, isActive: r.isActive === 1 });
  }
  return map;
}

export function getPriceHistory(
  vin: string
): { price: number; date: string }[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT price, date FROM price_history WHERE vin = $vin ORDER BY date ASC"
    )
    .all({ $vin: vin }) as { price: number; date: string }[];
}

export function excludeVin(vin: string, reason: string = ""): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO excluded_vins (vin, reason, excludedAt)
     VALUES ($vin, $reason, $excludedAt)`
  ).run({
    $vin: vin,
    $reason: reason,
    $excludedAt: new Date().toISOString(),
  });
}

export function unexcludeVin(vin: string): void {
  const db = getDb();
  db.prepare("DELETE FROM excluded_vins WHERE vin = $vin").run({ $vin: vin });
}

export function getExcludedVins(): { vin: string; reason: string; excludedAt: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT vin, reason, excludedAt FROM excluded_vins ORDER BY excludedAt DESC")
    .all() as { vin: string; reason: string; excludedAt: string }[];
}

export function isExcluded(vin: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT 1 FROM excluded_vins WHERE vin = $vin")
    .get({ $vin: vin });
  return !!row;
}

// --- HW4 manual overrides ---

export function setHw4Override(vin: string, hw4Status: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO hw4_overrides (vin, hw4Status, updatedAt)
     VALUES ($vin, $hw4Status, $updatedAt)`
  ).run({ $vin: vin, $hw4Status: hw4Status, $updatedAt: new Date().toISOString() });
  // Also update the listings table so it takes effect immediately
  db.prepare("UPDATE listings SET hw4Status = $hw4Status WHERE vin = $vin")
    .run({ $hw4Status: hw4Status, $vin: vin });
}

export function getHw4Overrides(): Map<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT vin, hw4Status FROM hw4_overrides").all() as { vin: string; hw4Status: string }[];
  return new Map(rows.map(r => [r.vin, r.hw4Status]));
}

// --- URL overrides ---

export function setUrlOverride(vin: string, url: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO url_overrides (vin, url, updatedAt)
     VALUES ($vin, $url, $updatedAt)`
  ).run({ $vin: vin, $url: url, $updatedAt: new Date().toISOString() });
  // Apply immediately to the listings table
  db.prepare("UPDATE listings SET url = $url WHERE vin = $vin")
    .run({ $url: url, $vin: vin });
}

export function removeUrlOverride(vin: string): void {
  const db = getDb();
  db.prepare("DELETE FROM url_overrides WHERE vin = $vin").run({ $vin: vin });
}

export function getUrlOverrides(): { vin: string; url: string; updatedAt: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT vin, url, updatedAt FROM url_overrides ORDER BY updatedAt DESC")
    .all() as { vin: string; url: string; updatedAt: string }[];
}

// --- Favorites ---

export function favoriteVin(vin: string, note: string = ""): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO favorites (vin, note, favoritedAt)
     VALUES ($vin, $note, $favoritedAt)`
  ).run({ $vin: vin, $note: note, $favoritedAt: new Date().toISOString() });
}

export function unfavoriteVin(vin: string): void {
  const db = getDb();
  db.prepare("DELETE FROM favorites WHERE vin = $vin").run({ $vin: vin });
}

export function getFavorites(): { vin: string; note: string; favoritedAt: string }[] {
  const db = getDb();
  return db
    .prepare("SELECT vin, note, favoritedAt FROM favorites ORDER BY favoritedAt DESC")
    .all() as { vin: string; note: string; favoritedAt: string }[];
}

export function isFavorite(vin: string): boolean {
  const db = getDb();
  return !!db.prepare("SELECT 1 FROM favorites WHERE vin = $vin").get({ $vin: vin });
}

// --- Scraper Logs ---

export interface ScraperLogEntry {
  refreshId: string;
  source: string;
  status: "success" | "error" | "skipped" | "timeout";
  rawCount: number;
  dedupedCount: number;
  filteredCount: number;
  errorMessage: string | null;
  durationMs: number;
  timestamp: string;
  type: "refresh" | "rescrape" | "enrich";
}

export function insertScraperLog(entry: ScraperLogEntry): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO scraper_logs (refreshId, source, status, rawCount, dedupedCount, filteredCount, errorMessage, durationMs, timestamp, type)
    VALUES ($refreshId, $source, $status, $rawCount, $dedupedCount, $filteredCount, $errorMessage, $durationMs, $timestamp, $type)
  `).run({
    $refreshId: entry.refreshId,
    $source: entry.source,
    $status: entry.status,
    $rawCount: entry.rawCount,
    $dedupedCount: entry.dedupedCount,
    $filteredCount: entry.filteredCount,
    $errorMessage: entry.errorMessage,
    $durationMs: entry.durationMs,
    $timestamp: entry.timestamp,
    $type: entry.type || "refresh",
  });
}

export function getScraperLogs(limit: number = 50): ScraperLogEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT refreshId, source, status, rawCount, dedupedCount, filteredCount, errorMessage, durationMs, timestamp,
           COALESCE(type, 'refresh') as type
    FROM scraper_logs
    ORDER BY timestamp DESC, id DESC
    LIMIT $limit
  `).all({ $limit: limit }) as ScraperLogEntry[];
}

// --- Listing field overrides ---

const OVERRIDE_FIELDS = [
  'price', 'mileage', 'year', 'trim', 'exteriorColor', 'interiorColor',
  'seatCount', 'dealerName', 'dealerLocation', 'titleStatus', 'accidentHistory',
] as const;

export function updateListingFields(vin: string, fields: Record<string, any>): void {
  const db = getDb();

  // Get existing overrides to merge (preserve fields not being updated)
  const existing = db.prepare('SELECT * FROM listing_overrides WHERE vin = ?').get(vin) as any;
  const now = new Date().toISOString();

  const merged: Record<string, any> = {};
  for (const f of OVERRIDE_FIELDS) {
    merged[f] = fields[f] !== undefined ? fields[f] : (existing?.[f] ?? null);
  }

  db.prepare(`
    INSERT OR REPLACE INTO listing_overrides (vin, price, mileage, year, trim, exteriorColor, interiorColor, seatCount, dealerName, dealerLocation, titleStatus, accidentHistory, updatedAt)
    VALUES ($vin, $price, $mileage, $year, $trim, $exteriorColor, $interiorColor, $seatCount, $dealerName, $dealerLocation, $titleStatus, $accidentHistory, $updatedAt)
  `).run({
    $vin: vin,
    $price: merged.price,
    $mileage: merged.mileage,
    $year: merged.year,
    $trim: merged.trim,
    $exteriorColor: merged.exteriorColor,
    $interiorColor: merged.interiorColor,
    $seatCount: merged.seatCount,
    $dealerName: merged.dealerName,
    $dealerLocation: merged.dealerLocation,
    $titleStatus: merged.titleStatus,
    $accidentHistory: merged.accidentHistory,
    $updatedAt: now,
  });

  // Apply directly to listings table
  const setClauses: string[] = [];
  const params: Record<string, any> = { $vin: vin };
  for (const [key, value] of Object.entries(fields)) {
    if (OVERRIDE_FIELDS.includes(key as any) && value !== undefined) {
      setClauses.push(`${key} = $${key}`);
      params[`$${key}`] = value;
    }
  }
  if (setClauses.length > 0) {
    db.prepare(`UPDATE listings SET ${setClauses.join(', ')} WHERE vin = $vin`).run(params);
  }
}

export function removeListingOverrides(vin: string): void {
  const db = getDb();
  db.prepare('DELETE FROM listing_overrides WHERE vin = ?').run(vin);
}

export function getListingOverrides(): { vin: string; fields: Record<string, any>; updatedAt: string }[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM listing_overrides').all() as any[];
  return rows.map(r => {
    const fields: Record<string, any> = {};
    for (const f of OVERRIDE_FIELDS) {
      if (r[f] != null) fields[f] = r[f];
    }
    return { vin: r.vin, fields, updatedAt: r.updatedAt };
  });
}

// --- Enrichment cache ---

export interface EnrichmentData {
  price?: number;
  mileage?: number;
  interiorColor?: string;
  exteriorColor?: string;
  imageUrl?: string;
  dealerUrl?: string;
}

/** Get active filtered listings missing price, mileage, interior color, or image, not enriched in last 7 days */
export function getEnrichmentCandidates(): { vin: string; price: number; mileage: number; interiorColor: string; imageUrl: string; dealerName: string; dealerLocation: string }[] {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT l.vin, l.price, l.mileage, l.interiorColor, l.imageUrl, l.dealerName, l.dealerLocation
    FROM listings l
    WHERE l.isActive = 1
      AND l.vin NOT IN (SELECT vin FROM excluded_vins)
      AND (l.price = 0 OR l.mileage = 0 OR l.interiorColor = '' OR l.interiorColor IS NULL
           OR l.imageUrl IS NULL OR l.imageUrl = '')
      AND l.vin NOT IN (SELECT vin FROM enrichment_cache WHERE searchedAt > $cutoff)
    ORDER BY
      (CASE WHEN l.price = 0 THEN 1 ELSE 0 END) +
      (CASE WHEN l.mileage = 0 THEN 1 ELSE 0 END) +
      (CASE WHEN l.interiorColor = '' OR l.interiorColor IS NULL THEN 1 ELSE 0 END) +
      (CASE WHEN l.imageUrl IS NULL OR l.imageUrl = '' THEN 1 ELSE 0 END) DESC
  `).all({ $cutoff: sevenDaysAgo }) as { vin: string; price: number; mileage: number; interiorColor: string; imageUrl: string; dealerName: string; dealerLocation: string }[];
}

/** Save enrichment results (upsert into enrichment_cache) */
export function saveEnrichment(vin: string, data: EnrichmentData): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO enrichment_cache (vin, price, mileage, interiorColor, exteriorColor, imageUrl, dealerUrl, searchedAt)
    VALUES ($vin, $price, $mileage, $interiorColor, $exteriorColor, $imageUrl, $dealerUrl, $searchedAt)
  `).run({
    $vin: vin,
    $price: data.price ?? null,
    $mileage: data.mileage ?? null,
    $interiorColor: data.interiorColor ?? null,
    $exteriorColor: data.exteriorColor ?? null,
    $imageUrl: data.imageUrl ?? null,
    $dealerUrl: data.dealerUrl ?? null,
    $searchedAt: new Date().toISOString(),
  });
}

/** Apply enrichment cache: fill blanks in listings from cached enrichment data */
export function applyEnrichmentCache(): void {
  const db = getDb();

  // Single bulk UPDATE using JOIN against enrichment_cache (replaces N+1 loop)
  db.exec(`
    UPDATE listings SET
      price = CASE WHEN listings.price = 0 AND e.price IS NOT NULL AND e.price > 0 THEN e.price ELSE listings.price END,
      mileage = CASE WHEN listings.mileage = 0 AND e.mileage IS NOT NULL AND e.mileage > 0 THEN e.mileage ELSE listings.mileage END,
      interiorColor = CASE WHEN (listings.interiorColor = '' OR listings.interiorColor IS NULL) AND e.interiorColor IS NOT NULL AND e.interiorColor != '' THEN e.interiorColor ELSE listings.interiorColor END,
      exteriorColor = CASE WHEN (listings.exteriorColor = '' OR listings.exteriorColor IS NULL) AND e.exteriorColor IS NOT NULL AND e.exteriorColor != '' THEN e.exteriorColor ELSE listings.exteriorColor END,
      imageUrl = CASE WHEN (listings.imageUrl IS NULL OR listings.imageUrl = '') AND e.imageUrl IS NOT NULL AND e.imageUrl != '' THEN e.imageUrl ELSE listings.imageUrl END,
      url = CASE
        WHEN listings.vin NOT IN (SELECT vin FROM url_overrides) AND e.dealerUrl IS NOT NULL AND e.dealerUrl != '' THEN e.dealerUrl
        ELSE listings.url END
    FROM enrichment_cache e
    WHERE listings.vin = e.vin
  `);
}

/** Get enrichment map: vin -> { fields enriched, values, dealerUrl, searchedAt } */
export function getEnrichmentMap(): Map<string, { fields: string[]; values: Record<string, any>; dealerUrl: string | null; searchedAt: string }> {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM enrichment_cache').all() as any[];
  const map = new Map<string, { fields: string[]; values: Record<string, any>; dealerUrl: string | null; searchedAt: string }>();
  for (const r of rows) {
    const fields: string[] = [];
    const values: Record<string, any> = {};
    if (r.price != null && r.price > 0) { fields.push('price'); values.price = r.price; }
    if (r.mileage != null && r.mileage > 0) { fields.push('mileage'); values.mileage = r.mileage; }
    if (r.interiorColor != null && r.interiorColor !== '') { fields.push('interiorColor'); values.interiorColor = r.interiorColor; }
    if (r.exteriorColor != null && r.exteriorColor !== '') { fields.push('exteriorColor'); values.exteriorColor = r.exteriorColor; }
    if (r.imageUrl != null && r.imageUrl !== '') { fields.push('imageUrl'); values.imageUrl = r.imageUrl; }
    map.set(r.vin, { fields, values, dealerUrl: r.dealerUrl || null, searchedAt: r.searchedAt });
  }
  return map;
}

/** Get enrichment data for a single VIN (avoids loading entire map) */
export function getEnrichmentByVin(vin: string): { fields: string[]; values: Record<string, any>; dealerUrl: string | null; searchedAt: string } | null {
  const db = getDb();
  const r = db.prepare('SELECT * FROM enrichment_cache WHERE vin = ?').get(vin) as any;
  if (!r) return null;
  const fields: string[] = [];
  const values: Record<string, any> = {};
  if (r.price != null && r.price > 0) { fields.push('price'); values.price = r.price; }
  if (r.mileage != null && r.mileage > 0) { fields.push('mileage'); values.mileage = r.mileage; }
  if (r.interiorColor != null && r.interiorColor !== '') { fields.push('interiorColor'); values.interiorColor = r.interiorColor; }
  if (r.exteriorColor != null && r.exteriorColor !== '') { fields.push('exteriorColor'); values.exteriorColor = r.exteriorColor; }
  if (r.imageUrl != null && r.imageUrl !== '') { fields.push('imageUrl'); values.imageUrl = r.imageUrl; }
  return { fields, values, dealerUrl: r.dealerUrl || null, searchedAt: r.searchedAt };
}

/** Delete enrichment cache rows for specific VINs (forces re-enrichment) */
export function clearEnrichmentCache(vins: string[]): void {
  const db = getDb();
  if (vins.length === 0) return;
  const placeholders = vins.map(() => '?').join(',');
  db.prepare(`DELETE FROM enrichment_cache WHERE vin IN (${placeholders})`).run(...vins);
}

/** Get listing data for specific VINs */
export function getListingsByVins(vins: string[]): { vin: string; price: number; mileage: number; interiorColor: string; imageUrl: string; dealerName: string; dealerLocation: string }[] {
  const db = getDb();
  if (vins.length === 0) return [];
  const placeholders = vins.map(() => '?').join(',');
  return db.prepare(`
    SELECT vin, price, mileage, interiorColor, imageUrl, dealerName, dealerLocation
    FROM listings WHERE vin IN (${placeholders})
  `).all(...vins) as { vin: string; price: number; mileage: number; interiorColor: string; imageUrl: string; dealerName: string; dealerLocation: string }[];
}

/** Re-apply all listing_overrides after a scraper refresh upsert */
export function applyListingOverrides(): void {
  const db = getDb();
  const overrides = db.prepare('SELECT * FROM listing_overrides').all() as any[];
  if (overrides.length === 0) return;

  const update = db.prepare(`
    UPDATE listings SET
      price = CASE WHEN $price IS NOT NULL THEN $price ELSE price END,
      mileage = CASE WHEN $mileage IS NOT NULL THEN $mileage ELSE mileage END,
      year = CASE WHEN $year IS NOT NULL THEN $year ELSE year END,
      trim = CASE WHEN $trim IS NOT NULL THEN $trim ELSE trim END,
      exteriorColor = CASE WHEN $exteriorColor IS NOT NULL THEN $exteriorColor ELSE exteriorColor END,
      interiorColor = CASE WHEN $interiorColor IS NOT NULL THEN $interiorColor ELSE interiorColor END,
      seatCount = CASE WHEN $seatCount IS NOT NULL THEN $seatCount ELSE seatCount END,
      dealerName = CASE WHEN $dealerName IS NOT NULL THEN $dealerName ELSE dealerName END,
      dealerLocation = CASE WHEN $dealerLocation IS NOT NULL THEN $dealerLocation ELSE dealerLocation END,
      titleStatus = CASE WHEN $titleStatus IS NOT NULL THEN $titleStatus ELSE titleStatus END,
      accidentHistory = CASE WHEN $accidentHistory IS NOT NULL THEN $accidentHistory ELSE accidentHistory END
    WHERE vin = $vin
  `);

  const transaction = db.transaction(() => {
    for (const o of overrides) {
      update.run({
        $vin: o.vin,
        $price: o.price,
        $mileage: o.mileage,
        $year: o.year,
        $trim: o.trim,
        $exteriorColor: o.exteriorColor,
        $interiorColor: o.interiorColor,
        $seatCount: o.seatCount,
        $dealerName: o.dealerName,
        $dealerLocation: o.dealerLocation,
        $titleStatus: o.titleStatus,
        $accidentHistory: o.accidentHistory,
      });
    }
  });
  transaction();
}

// --- Purge non-Plaid listings ---

/**
 * Delete all non-Plaid listings from the DB and all related tables.
 * VIN position 8 (1-indexed): '6' = Plaid, '5' = Long Range.
 */
export function purgeNonPlaid(): number {
  const db = getDb();

  const condition = `
    (length(vin) = 17 AND substr(vin, 4, 1) = 'X' AND substr(vin, 8, 1) != '6')
    OR (trim != '' AND trim IS NOT NULL AND trim != 'Plaid')
  `;

  const nonPlaid = db.prepare(`SELECT vin FROM listings WHERE ${condition}`).all() as { vin: string }[];
  if (nonPlaid.length === 0) return 0;

  const vins = nonPlaid.map(r => r.vin);
  const tables = ["price_history", "enrichment_cache", "excluded_vins", "favorites", "hw4_overrides", "url_overrides", "listing_overrides", "listings"];

  // Bulk DELETE using IN clause, chunked to stay under SQLite's 999 variable limit
  const purge = db.transaction(() => {
    for (let i = 0; i < vins.length; i += 500) {
      const chunk = vins.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(',');
      for (const table of tables) {
        db.prepare(`DELETE FROM ${table} WHERE vin IN (${placeholders})`).run(...chunk);
      }
    }
  });
  purge();

  return nonPlaid.length;
}
