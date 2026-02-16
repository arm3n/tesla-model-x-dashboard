export type Hw4Status = "confirmed" | "likely" | "uncertain" | "no";

const YEAR_CODES: Record<string, number> = {
  N: 2022,
  P: 2023,
  R: 2024,
  S: 2025,
  T: 2026,
};

export function checkHw4(vin: string): Hw4Status {
  if (vin.length !== 17) return "no";

  // Position 4 must be X (Model X) — VIN is 0-indexed here
  if (vin[3] !== "X") return "no";

  const yearCode = vin[9];
  const year = YEAR_CODES[yearCode];

  if (!year) return "no";

  // 2024+ are all HW4
  if (year >= 2024) return "confirmed";

  // 2023 — transition year (HW3→HW4 cutover was messy, not a single point)
  // Community data: PF383xx=HW4, PF384xxx=HW3, PF385xxx+=HW4, no HW3 above 390k
  if (year === 2023) {
    const serial = parseInt(vin.slice(11, 17), 10);
    if (isNaN(serial)) return "uncertain";
    if (serial >= 390_000) return "confirmed";
    if (serial >= 385_000) return "likely";
    if (serial >= 370_000) return "uncertain";
    return "no";
  }

  return "no";
}

export function getYearFromVin(vin: string): number | null {
  if (vin.length !== 17) return null;
  return YEAR_CODES[vin[9]] ?? null;
}

/**
 * Decode seat count from VIN position 6 (0-indexed: 5).
 * Tesla encodes restraint/seating config:
 *   A = 7-seat (2+3+2, 3 rows)
 *   B = 6-seat (2+2+2, 3 rows, captain's chairs)
 *   C = 6-seat (variant)
 *   D = 5-seat (2+3, 2 rows, no third row)
 */
const SEAT_COUNT_BY_POS6: Record<string, number> = {
  A: 7,
  B: 6,
  C: 6,
  D: 5,
};

export function getSeatCountFromVin(vin: string): number | null {
  if (vin.length !== 17) return null;
  // Must be Model X (position 4 = X)
  if (vin[3] !== "X") return null;
  return SEAT_COUNT_BY_POS6[vin[5]] ?? null;
}

/**
 * Decode trim (Long Range vs Plaid) from VIN position 8 (0-indexed: 7).
 * Tesla encodes motor/drive unit type:
 *   5 = P2 Dual Motor → Long Range AWD
 *   6 = P2 Tri Motor  → Plaid
 */
const TRIM_BY_POS8: Record<string, string> = {
  "5": "Long Range",
  "6": "Plaid",
};

export function getTrimFromVin(vin: string): string | null {
  if (vin.length !== 17) return null;
  if (vin[3] !== "X") return null;
  return TRIM_BY_POS8[vin[7]] ?? null;
}
