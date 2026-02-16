import type { Browser, BrowserContext } from "playwright";

/**
 * Launches a stealth-configured browser using playwright-extra + stealth plugin.
 * Uses the system Chrome installation (channel: "chrome") which is significantly
 * harder to fingerprint than bundled Chromium.
 */
export async function launchStealthBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const { chromium } = await import("playwright-extra");
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;

  chromium.use(StealthPlugin());

  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    timeout: 30_000,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
  });

  return { browser, context };
}
