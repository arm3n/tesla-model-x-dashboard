import type { Listing, RawListing, Source } from "./scraper/types.ts";
import { checkHw4, getSeatCountFromVin, getTrimFromVin } from "./vin/hw4-check.ts";
import { decodeOptionCodes } from "./vin/option-codes.ts";
import { computeCompleteness } from "./completeness.ts";

/**
 * Detect black interior variants. Catches:
 *   "Black", "All Black", "Ebony", "BLACK"
 *   "Black w/ Carbon Fiber", "Black W/Premium Seat Trim", "Black W"
 *   "Black Leather", "Black Leatherette"
 *   "Blk/Black", "Charcoal" (dark gray alias)
 * Keeps two-tones: "Black and White", "Black And White W/ Carbon Fibe"
 */
function isBlackInterior(color: string): boolean {
  const c = color.trim();
  if (!c) return false;
  const lower = c.toLowerCase();
  // Two-tone with white — keep these
  if (/black\s+(and|&)\s+white/i.test(c)) return false;
  if (lower === 'white/black' || lower === 'white black') return false;
  // Exact matches
  if (/^(black|all black|ebony|charcoal)$/i.test(c)) return true;
  // Starts with "black" (catches "Black W/...", "Black Leather", etc.)
  if (/^black\b/i.test(c)) return true;
  // "Blk/Black" and similar abbreviations
  if (/\bblk\b/i.test(c)) return true;
  return false;
}

function detectSeatCount(raw: RawListing): number | null {
  // VIN position 6 is the most reliable source (Tesla's NHTSA filing)
  const vinSeatCount = getSeatCountFromVin(raw.vin);
  if (vinSeatCount) return vinSeatCount;

  if (raw.seatCount) return raw.seatCount;

  // Try option codes (Tesla API)
  if (raw.optionCodes?.length) {
    const decoded = decodeOptionCodes(raw.optionCodes);
    if (decoded.seatCount) return decoded.seatCount;
  }

  const text = `${raw.trim}`.toLowerCase();
  if (text.includes("6 seat") || text.includes("six seat")) return 6;
  if (text.includes("7 seat") || text.includes("seven seat")) return 7;
  if (text.includes("5 seat") || text.includes("five seat")) return 5;

  return null;
}

/** Source priority for deduplication — lower = preferred */
const SOURCE_PRIORITY: Record<Source, number> = {
  tesla: 0,
  marketcheck: 1,
  "auto.dev": 2,
  autotrader: 3,
  "cars.com": 4,
  truecar: 5,
  edmunds: 6,
  carfax: 7,
  ebay: 8,
  cargurus: 9,
};

const SALVAGE_PATTERNS = /\b(salvage|rebuilt|flood|lemon|junk|parts only|certificate of destruction|non-repairable)\b/i;

function isBadTitle(status: string | null | undefined): boolean {
  if (!status) return false;
  return SALVAGE_PATTERNS.test(status) || status.toLowerCase() === "branded";
}

export async function normalize(
  rawListings: RawListing[],
  existingListings?: Map<string, Listing>
): Promise<Listing[]> {
  const now = new Date().toISOString();

  // Skip slow URL verification — it makes HTTP requests for every duplicate-VIN
  // URL (8s timeout each, 5 concurrent) which blocks normalization for minutes.
  // URL verified status is just 1/14 completeness points; not worth the latency.
  const urlStatus = new Map<string, boolean>();

  // Deduplicate by VIN — prefer most complete data, merge fields
  const byVin = new Map<string, RawListing[]>();
  for (const raw of rawListings) {
    const vin = raw.vin.toUpperCase();
    if (!byVin.has(vin)) byVin.set(vin, []);
    byVin.get(vin)!.push(raw);
  }

  const listings: Listing[] = [];

  for (const [vin, raws] of byVin) {
    // Score each raw listing by completeness, then source priority as tiebreaker.
    // Tesla CPO always wins — user wants the direct Tesla link when available.
    const sorted = raws.sort((a, b) => {
      // Tesla always wins dedup (CPO listing is most valuable)
      if (a.source === "tesla" && b.source !== "tesla") return -1;
      if (b.source === "tesla" && a.source !== "tesla") return 1;
      const aVerified = urlStatus.get(a.url) ?? true; // single-source VINs default to true
      const bVerified = urlStatus.get(b.url) ?? true;
      const aScore = computeCompleteness(a, aVerified);
      const bScore = computeCompleteness(b, bVerified);
      if (bScore !== aScore) return bScore - aScore; // higher completeness wins
      return SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]; // lower priority number wins
    });

    const primary = sorted[0]!;

    // Merge: fill missing fields from other sources
    let seatCount = detectSeatCount(primary);
    let interiorColor = primary.interiorColor;
    let exteriorColor = primary.exteriorColor;
    let imageUrl = primary.imageUrl;
    let titleStatus = primary.titleStatus ?? null;
    let accidentHistory = primary.accidentHistory ?? "unknown";

    for (const alt of sorted.slice(1)) {
      if (!seatCount) seatCount = detectSeatCount(alt);
      if (!interiorColor) interiorColor = alt.interiorColor;
      if (!exteriorColor) exteriorColor = alt.exteriorColor;
      if (!imageUrl) imageUrl = alt.imageUrl;
      if (!titleStatus && alt.titleStatus) titleStatus = alt.titleStatus;
      if (accidentHistory === "unknown" && alt.accidentHistory && alt.accidentHistory !== "unknown") {
        accidentHistory = alt.accidentHistory;
      }
    }

    // Try option codes for color enrichment
    if (primary.optionCodes?.length) {
      const decoded = decodeOptionCodes(primary.optionCodes);
      if (!exteriorColor && decoded.exteriorColor) {
        exteriorColor = decoded.exteriorColor;
      }
      if (!interiorColor && decoded.interiorColor) {
        interiorColor = decoded.interiorColor;
      }
    }

    const hw4Status = checkHw4(vin);

    // Option code can definitively confirm or deny HW4
    let finalHw4 = hw4Status;
    if (primary.optionCodes?.length) {
      const decoded = decodeOptionCodes(primary.optionCodes);
      if (decoded.hasHw4 === true) finalHw4 = "confirmed";
      else if (decoded.hasHw4 === false && hw4Status !== "confirmed") finalHw4 = "no";
    }

    const existing = existingListings?.get(vin);

    // Defensive: ensure numeric fields are actually numbers
    const num = (v: unknown): number =>
      typeof v === "number" ? v
        : typeof v === "string" ? parseInt(v.replace(/[^0-9]/g, ""), 10) || 0
        : v && typeof v === "object" && "value" in v ? num((v as any).value)
        : 0;
    const str = (v: unknown): string =>
      typeof v === "string" ? v
        : v && typeof v === "object" && "value" in v ? String((v as any).value ?? "")
        : v == null ? "" : String(v);

    // VIN position 8 definitively encodes Long Range (5) vs Plaid (6)
    const vinTrim = getTrimFromVin(vin);

    const primaryUrlVerified = urlStatus.get(primary.url) ?? true;
    const primaryScore = computeCompleteness(primary, primaryUrlVerified);

    listings.push({
      vin,
      source: primary.source,
      url: str(primary.url),
      price: num(primary.price),
      mileage: num(primary.mileage),
      year: num(primary.year),
      trim: vinTrim ?? str(primary.trim),
      exteriorColor,
      interiorColor,
      seatCount,
      hw4Status: finalHw4,
      dealerName: primary.dealerName,
      dealerLocation: primary.dealerLocation,
      imageUrl,
      listedDate: primary.listedDate,
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      isActive: true,
      titleStatus,
      accidentHistory,
      completenessScore: primaryScore,
      urlVerified: primaryUrlVerified,
    });
  }

  return listings;
}

export function filterListings(listings: Listing[]): Listing[] {
  return listings.filter((l) => {
    // HW4: keep confirmed, likely, or uncertain
    if (l.hw4Status === "no") return false;

    // Non-black interior
    if (isBlackInterior(l.interiorColor)) return false;

    // 6-seater or unknown (show unknown with badge, don't exclude)
    if (l.seatCount !== null && l.seatCount !== 6) return false;

    // Filter out salvage/lemon/branded titles
    if (isBadTitle(l.titleStatus)) return false;

    // Filter out vehicles with known accidents
    if (l.accidentHistory === "accident") return false;

    return true;
  });
}
