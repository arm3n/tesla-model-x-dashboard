/**
 * Decode Tesla option codes for Model X.
 * Reference: https://tesla-api.timdorr.com/vehicle/optioncodes
 */

// Interior color codes
const INTERIOR_COLORS: Record<string, string> = {
  IBB0: "Black",
  IBB1: "Black",
  IBE00: "Black",
  IBW0: "Black and White",
  IBW1: "Black and White",
  ICW0: "Cream",
  ICW1: "Cream",
  IBC0: "Black",
  IWW0: "White",
  IWW1: "White",
  IPW0: "White",
  IPW1: "White",
  IN3PB: "Black",
  IN3PW: "White",
};

// Seat configuration codes
const SEAT_CONFIGS: Record<string, number> = {
  ST00: 5,
  ST01: 5,
  ST02: 6,
  ST03: 7,
  ST04: 5,
  MTY05: 5,
  MTY06: 6,
  MTY07: 7,
  "5-Seat": 5,
  "6-Seat": 6,
  "7-Seat": 7,
  SIX_SEAT: 6,
  FIVE_SEAT: 5,
  SEVEN_SEAT: 7,
};

// Autopilot/FSD codes — these indicate software, not hardware
// HW4 is determined by build date (2024+ confirmed, late 2023 transition)
const AP_CODES: Record<string, string> = {
  APF0: "Autopilot",
  APF1: "Full Self-Driving",
  APF2: "Enhanced Autopilot",
  APFB: "Full Self-Driving",
  APH2: "Autopilot HW2",
  APH3: "Autopilot HW3",
  APH4: "Autopilot HW4",
  APPA: "Autopilot",
  $APF0: "Autopilot",
  $APF1: "Full Self-Driving",
  $APF2: "Enhanced Autopilot",
  $APFB: "Full Self-Driving",
};

export interface DecodedOptions {
  interiorColor: string | null;
  seatCount: number | null;
  hasHw4: boolean | null;
  autopilot: string | null;
}

export function decodeOptionCodes(codes: string[]): DecodedOptions {
  let interiorColor: string | null = null;
  let seatCount: number | null = null;
  let hasHw4: boolean | null = null;
  let autopilot: string | null = null;

  for (const code of codes) {
    const c = code.trim().replace(/^\$/, "");

    if (INTERIOR_COLORS[c]) {
      interiorColor = INTERIOR_COLORS[c];
    }

    if (SEAT_CONFIGS[c] !== undefined) {
      seatCount = SEAT_CONFIGS[c];
    }

    if (c === "APH4") {
      hasHw4 = true;
    } else if (c === "APH3" || c === "APH2") {
      hasHw4 = false;
    }

    if (AP_CODES[code]) {
      autopilot = AP_CODES[code];
    }
  }

  return { interiorColor, seatCount, hasHw4, autopilot };
}
