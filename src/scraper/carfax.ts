import type { RawListing } from "./types.ts";

/**
 * CarFax scraper — currently disabled.
 *
 * CarFax uses DataDome CAPTCHA (captcha-delivery.com) which blocks both
 * Playwright stealth and nodriver. The entire page is replaced with a
 * full-screen DataDome challenge iframe that cannot be auto-solved.
 *
 * CarFax data (accident history, title status) is also available from
 * Autotrader (vhrPreview badges) and Edmunds (historyInfo), so this
 * source is not critical.
 *
 * To re-enable: would need a CAPTCHA-solving service or a different
 * data access method (e.g., CarFax API partnership).
 */
export async function scrapeCarfax(): Promise<RawListing[]> {
  console.log("[CarFax] Skipped — blocked by DataDome CAPTCHA");
  return [];
}
