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
      accidentHistory TEXT NOT NULL DEFAULT 'unknown'
    )
  `);

  // Migrate: add columns if missing (for existing DBs)
  try { _db.exec("ALTER TABLE listings ADD COLUMN titleStatus TEXT"); } catch {}
  try { _db.exec("ALTER TABLE listings ADD COLUMN accidentHistory TEXT NOT NULL DEFAULT 'unknown'"); } catch {}

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

  return _db;
}

export function upsertListings(listings: Listing[]): void {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO listings (
      vin, source, url, price, mileage, year, trim,
      exteriorColor, interiorColor, seatCount, hw4Status,
      dealerName, dealerLocation, imageUrl, listedDate,
      firstSeen, lastSeen, isActive, titleStatus, accidentHistory
    ) VALUES (
      $vin, $source, $url, $price, $mileage, $year, $trim,
      $exteriorColor, $interiorColor, $seatCount, $hw4Status,
      $dealerName, $dealerLocation, $imageUrl, $listedDate,
      $firstSeen, $lastSeen, $isActive, $titleStatus, $accidentHistory
    )
    ON CONFLICT(vin) DO UPDATE SET
      source = $source,
      url = $url,
      price = $price,
      mileage = $mileage,
      year = $year,
      trim = $trim,
      exteriorColor = $exteriorColor,
      interiorColor = $interiorColor,
      seatCount = COALESCE($seatCount, listings.seatCount),
      hw4Status = CASE
        WHEN vin IN (SELECT vin FROM hw4_overrides) THEN listings.hw4Status
        ELSE $hw4Status
      END,
      dealerName = $dealerName,
      dealerLocation = $dealerLocation,
      imageUrl = COALESCE($imageUrl, listings.imageUrl),
      listedDate = COALESCE($listedDate, listings.listedDate),
      lastSeen = $lastSeen,
      isActive = $isActive,
      titleStatus = COALESCE($titleStatus, listings.titleStatus),
      accidentHistory = CASE
        WHEN $accidentHistory != 'unknown' THEN $accidentHistory
        ELSE COALESCE(listings.accidentHistory, 'unknown')
      END
  `);

  const insertPrice = db.prepare(`
    INSERT INTO price_history (vin, price, date) VALUES ($vin, $price, $date)
  `);

  const getExisting = db.prepare(`
    SELECT price FROM listings WHERE vin = $vin
  `);

  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    for (const listing of listings) {
      // Check if price changed
      const existing = getExisting.get({ $vin: listing.vin }) as
        | { price: number }
        | undefined;
      if (existing && existing.price !== listing.price) {
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

export function getFilteredListings(): (Listing & { isFavorite: boolean })[] {
  const db = getDb();
  const rows = db
    .prepare(
      `
    SELECT l.*,
      CASE WHEN f.vin IS NOT NULL THEN 1 ELSE 0 END AS isFavorite
    FROM listings l
    LEFT JOIN favorites f ON l.vin = f.vin
    WHERE l.isActive = 1
      AND l.vin NOT IN (SELECT vin FROM excluded_vins)
      AND l.hw4Status IN ('confirmed', 'likely', 'uncertain', 'ask dealer')
      AND LOWER(l.interiorColor) NOT IN ('black', 'all black', 'ebony', 'charcoal')
      AND l.interiorColor NOT LIKE 'Black %'
      AND l.interiorColor NOT LIKE 'Blk%'
      AND (l.interiorColor NOT LIKE '%black%' OR l.interiorColor LIKE '%white%black%' OR l.interiorColor LIKE '%black%white%')
      AND (l.seatCount = 6 OR l.seatCount IS NULL)
      AND (l.titleStatus IS NULL OR LOWER(l.titleStatus) NOT IN ('salvage', 'rebuilt', 'flood', 'lemon', 'junk', 'branded'))
      AND l.accidentHistory != 'accident'
    ORDER BY isFavorite DESC, l.price ASC
  `
    )
    .all() as (Listing & { isActive: number; isFavorite: number })[];

  return rows.map((r) => ({ ...r, isActive: r.isActive === 1, isFavorite: r.isFavorite === 1 }));
}

export function getAllListings(): (Listing & { isFavorite: boolean })[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT l.*,
        CASE WHEN f.vin IS NOT NULL THEN 1 ELSE 0 END AS isFavorite
      FROM listings l
      LEFT JOIN favorites f ON l.vin = f.vin
      WHERE l.isActive = 1
      ORDER BY isFavorite DESC, l.price ASC
    `)
    .all() as (Listing & { isActive: number; isFavorite: number })[];
  return rows.map((r) => ({ ...r, isActive: r.isActive === 1, isFavorite: r.isFavorite === 1 }));
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
