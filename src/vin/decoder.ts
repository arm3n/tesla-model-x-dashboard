interface NhtsaResult {
  Variable: string;
  Value: string | null;
}

interface NhtsaResponse {
  Results: NhtsaResult[];
}

export interface VinDecodeResult {
  year: number | null;
  make: string | null;
  model: string | null;
  bodyClass: string | null;
  plantCountry: string | null;
  driveType: string | null;
  trim: string | null;
}

export async function decodeVin(vin: string): Promise<VinDecodeResult> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`NHTSA API error: ${res.status}`);
  }

  const data = (await res.json()) as NhtsaResponse;
  const get = (name: string): string | null => {
    const item = data.Results.find((r) => r.Variable === name);
    return item?.Value?.trim() || null;
  };

  return {
    year: parseInt(get("Model Year") ?? "", 10) || null,
    make: get("Make"),
    model: get("Model"),
    bodyClass: get("Body Class"),
    plantCountry: get("Plant Country"),
    driveType: get("Drive Type"),
    trim: get("Trim"),
  };
}
