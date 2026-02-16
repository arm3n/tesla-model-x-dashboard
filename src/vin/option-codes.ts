/**
 * Decode Tesla option codes for Model X.
 * Reference: https://tesla-api.timdorr.com/vehicle/optioncodes
 */

// Exterior paint codes (from Tesla compositor URLs)
const EXTERIOR_COLORS: Record<string, string> = {
  PPSW: "Pearl White Multi-Coat",
  PBSB: "Solid Black",
  PMNG: "Midnight Silver Metallic",
  PPMR: "Red Multi-Coat",
  PPSB: "Deep Blue Metallic",
  PPSR: "Signature Red",
  PMBL: "Obsidian Black Metallic",
  PMSS: "Silver Metallic",
  PPTI: "Titanium Metallic",
  PMMB: "Midnight Cherry Red",
  PPCP: "Quicksilver",
  PR01: "Ultra Red",
  PR00: "Red",
  PB00: "Solid Black",
  PB01: "Solid Black",
  PN00: "Midnight Silver Metallic",
  PN01: "Midnight Silver Metallic",
  PW00: "Pearl White Multi-Coat",
  PW01: "Pearl White Multi-Coat",
};

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
  // Compositor URL interior codes (INXXX format)
  INBC3P: "Black",
  INB3P: "Black",
  INBC3W: "Black and White",
  INB3W: "Black and White",
  INBCW: "Black and White",
  INBFB: "Cream",
  INFBB: "Cream",
  INBBW: "Black and White",
  INWW: "White",
  INPB0: "Black",
  INPW0: "White",
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
  exteriorColor: string | null;
  interiorColor: string | null;
  seatCount: number | null;
  hasHw4: boolean | null;
  autopilot: string | null;
}

export function decodeOptionCodes(codes: string[]): DecodedOptions {
  let exteriorColor: string | null = null;
  let interiorColor: string | null = null;
  let seatCount: number | null = null;
  let hasHw4: boolean | null = null;
  let autopilot: string | null = null;

  for (const code of codes) {
    const c = code.trim().replace(/^\$/, "");

    if (EXTERIOR_COLORS[c]) {
      exteriorColor = EXTERIOR_COLORS[c];
    }

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

  return { exteriorColor, interiorColor, seatCount, hasHw4, autopilot };
}
