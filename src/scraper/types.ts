export type Source =
  | "marketcheck"
  | "auto.dev"
  | "cars.com"
  | "cargurus"
  | "tesla"
  | "truecar"
  | "autotrader"
  | "ebay"
  | "edmunds"
  | "carfax";

export interface Listing {
  vin: string;
  source: Source;
  url: string;
  price: number;
  mileage: number;
  year: number;
  trim: string;
  exteriorColor: string;
  interiorColor: string;
  seatCount: number | null;
  hw4Status: "confirmed" | "likely" | "uncertain" | "no";
  dealerName: string;
  dealerLocation: string;
  imageUrl: string | null;
  listedDate: string | null;
  firstSeen: string;
  lastSeen: string;
  isActive: boolean;
  titleStatus: string | null;
  accidentHistory: "clean" | "accident" | "unknown";
  completenessScore?: number;
  urlVerified?: boolean;
}

export interface RawListing {
  vin: string;
  source: Source;
  url: string;
  price: number;
  mileage: number;
  year: number;
  trim: string;
  exteriorColor: string;
  interiorColor: string;
  seatCount: number | null;
  dealerName: string;
  dealerLocation: string;
  imageUrl: string | null;
  listedDate: string | null;
  titleStatus?: string | null;
  accidentHistory?: "clean" | "accident" | "unknown";
  /** Tesla option codes for definitive HW4/seat/color decode */
  optionCodes?: string[];
}
