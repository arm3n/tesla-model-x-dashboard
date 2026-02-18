import type { RawListing } from "./types.ts";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir =
  typeof (import.meta as any).dir === "string"
    ? (import.meta as any).dir
    : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dir, "../..");
const FETCH_SCRIPT = resolve(PROJECT_ROOT, "scripts/cars-com-fetch.py");

function parseItem(item: any): RawListing | null {
  const vin = (item.vin ?? "").toUpperCase();
  if (!vin || vin.length !== 17) return null;

  return {
    vin,
    source: "cars.com",
    url: item.url ?? "",
    price: item.price ?? 0,
    mileage: item.mileage ?? 0,
    year: item.year ?? 0,
    trim: item.trim ?? "",
    exteriorColor: item.exteriorColor ?? "",
    interiorColor: item.interiorColor ?? "",
    seatCount: null,
    dealerName: item.dealer ?? "",
    dealerLocation: item.location ?? "",
    imageUrl: item.imageUrl ?? null,
    listedDate: null,
  };
}

/**
 * Scrapes Cars.com used Tesla Model X Plaid inventory using a Python subprocess
 * (nodriver / undetected Chrome) to bypass Cars.com's bot detection.
 */
export async function scrapeCarsCom(
  onProgress?: (msg: string) => void,
  onPartialResults?: (batch: RawListing[]) => void,
): Promise<RawListing[]> {
  const msg = "[Cars.com] Launching Python scraper (nodriver)...";
  console.log(msg);
  onProgress?.(msg);

  const proc = Bun.spawn(["python", FETCH_SCRIPT], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // 175s timeout — kill subprocess before the 180s refresh-level timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    const tmsg = "[Cars.com] Timed out after 175s — killed subprocess";
    console.error(tmsg);
    onProgress?.(tmsg);
  }, 175_000);

  const results: RawListing[] = [];

  // Stream stderr line-by-line for real-time progress
  const stderrReader = proc.stderr.getReader();
  const stderrDecoder = new TextDecoder();
  let stderrBuf = "";
  const stderrDone = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrBuf += stderrDecoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nlIdx).trim();
          stderrBuf = stderrBuf.slice(nlIdx + 1);
          if (line) {
            console.log(line);
            onProgress?.(line);
          }
        }
      }
      if (stderrBuf.trim()) {
        console.log(stderrBuf.trim());
        onProgress?.(stderrBuf.trim());
      }
    } catch {}
  })();

  // Stream stdout and parse per-page results incrementally
  const stdoutReader = proc.stdout.getReader();
  const stdoutDecoder = new TextDecoder();
  let stdoutBuf = "";
  const PAGE_START = "__CARSCOM_PAGE_RESULTS__";
  const PAGE_END = "__END_PAGE__";

  const stdoutDone = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuf += stdoutDecoder.decode(value, { stream: true });

        let startIdx: number;
        while ((startIdx = stdoutBuf.indexOf(PAGE_START)) !== -1) {
          const endIdx = stdoutBuf.indexOf(PAGE_END, startIdx);
          if (endIdx === -1) break;

          const jsonStr = stdoutBuf.slice(startIdx + PAGE_START.length, endIdx);
          stdoutBuf = stdoutBuf.slice(endIdx + PAGE_END.length);

          try {
            const items: any[] = JSON.parse(jsonStr);
            const batch: RawListing[] = [];
            for (const item of items) {
              const parsed = parseItem(item);
              if (parsed) {
                results.push(parsed);
                batch.push(parsed);
              }
            }
            if (batch.length > 0) onPartialResults?.(batch);
            onProgress?.(`[Cars.com] Streaming: ${results.length} listings so far`);
          } catch (err) {
            console.error("[Cars.com] Failed to parse page results:", (err as Error).message);
          }
        }
      }
    } catch {}
  })();

  await Promise.all([stderrDone, stdoutDone]);
  await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    console.log(`[Cars.com] Timed out but collected ${results.length} partial listings`);
    return results;
  }

  // Check for final bulk marker (fallback if streaming yielded nothing)
  const FINAL_START = "__CARSCOM_RESULTS_START__";
  const FINAL_END = "__CARSCOM_RESULTS_END__";
  const finalStartIdx = stdoutBuf.indexOf(FINAL_START);
  const finalEndIdx = stdoutBuf.indexOf(FINAL_END);
  if (finalStartIdx !== -1 && finalEndIdx !== -1 && results.length === 0) {
    try {
      const jsonStr = stdoutBuf.slice(finalStartIdx + FINAL_START.length, finalEndIdx).trim();
      const items: any[] = JSON.parse(jsonStr);
      for (const item of items) {
        const parsed = parseItem(item);
        if (parsed) results.push(parsed);
      }
    } catch {}
  }

  if (results.length === 0) {
    console.log("[Cars.com] 0 listings — likely blocked or no VINs extracted");
  } else {
    console.log(`[Cars.com] Done — ${results.length} listings`);
  }

  return results;
}
