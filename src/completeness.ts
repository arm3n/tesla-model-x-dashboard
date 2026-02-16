import type { RawListing } from "./scraper/types.ts";

/**
 * Compute a completeness score (0–14) for a listing.
 * Each populated field earns 1 point. Used as the primary
 * tie-breaker when multiple sources report the same VIN.
 */
export function computeCompleteness(
  raw: RawListing,
  urlVerified: boolean
): number {
  let score = 0;

  if (raw.price > 0) score++;
  if (raw.mileage > 0) score++;
  if (raw.year > 0) score++;
  if (raw.trim && raw.trim.trim() !== "") score++;
  if (raw.exteriorColor && raw.exteriorColor.trim() !== "") score++;
  if (raw.interiorColor && raw.interiorColor.trim() !== "") score++;
  if (raw.seatCount !== null && raw.seatCount !== undefined) score++;
  if (raw.dealerName && raw.dealerName.trim() !== "") score++;
  if (raw.dealerLocation && raw.dealerLocation.trim() !== "") score++;
  if (raw.imageUrl) score++;
  if (raw.listedDate) score++;
  if (raw.titleStatus) score++;
  if (raw.accidentHistory && raw.accidentHistory !== "unknown") score++;
  if (urlVerified) score++;

  return score;
}
