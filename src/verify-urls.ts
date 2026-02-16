import type { RawListing } from "./scraper/types.ts";

/** In-memory cache: url → { verified, expiry } */
const cache = new Map<string, { verified: boolean; expiry: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONCURRENCY = 5;
const TIMEOUT_MS = 8_000;

async function checkUrl(url: string): Promise<boolean> {
  // Check cache first
  const cached = cache.get(url);
  if (cached && Date.now() < cached.expiry) return cached.verified;

  let verified = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Try HEAD first
    let res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });

    // Fallback to GET if HEAD is rejected
    if (res.status === 405 || res.status === 403) {
      res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
      });
    }

    clearTimeout(timer);
    verified = res.ok; // 2xx
  } catch {
    verified = false;
  }

  cache.set(url, { verified, expiry: Date.now() + CACHE_TTL_MS });
  return verified;
}

/**
 * Verify URLs only for VINs that appear in 2+ sources.
 * Returns a Map<url, boolean> for every URL that was checked.
 * Single-source VINs are skipped entirely (their URLs are not checked).
 */
export async function verifyDuplicateUrls(
  rawListings: RawListing[]
): Promise<Map<string, boolean>> {
  // Identify VINs with 2+ sources
  const byVin = new Map<string, RawListing[]>();
  for (const raw of rawListings) {
    const vin = raw.vin.toUpperCase();
    if (!byVin.has(vin)) byVin.set(vin, []);
    byVin.get(vin)!.push(raw);
  }

  // Collect URLs to check (only from duplicate VINs)
  const urlsToCheck: string[] = [];
  for (const [, raws] of byVin) {
    if (raws.length < 2) continue;
    for (const raw of raws) {
      if (raw.url && !cache.has(raw.url)) urlsToCheck.push(raw.url);
    }
  }

  // Run with concurrency limit
  const results = new Map<string, boolean>();
  for (let i = 0; i < urlsToCheck.length; i += CONCURRENCY) {
    const batch = urlsToCheck.slice(i, i + CONCURRENCY);
    const checks = await Promise.all(batch.map((url) => checkUrl(url)));
    for (let j = 0; j < batch.length; j++) {
      results.set(batch[j]!, checks[j]!);
    }
  }

  // Also include cached results for duplicate-VIN URLs that were already cached
  for (const [, raws] of byVin) {
    if (raws.length < 2) continue;
    for (const raw of raws) {
      if (raw.url && !results.has(raw.url)) {
        const cached = cache.get(raw.url);
        if (cached) results.set(raw.url, cached.verified);
      }
    }
  }

  return results;
}
