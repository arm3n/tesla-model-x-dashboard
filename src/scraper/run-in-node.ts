import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { RawListing } from "./types.ts";

// Compatible with both Bun (import.meta.dir) and Node.js (import.meta.url)
const __dir =
  typeof (import.meta as any).dir === "string"
    ? (import.meta as any).dir
    : dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = resolve(__dir, "../..");
const RUNNER_SCRIPT = resolve(PROJECT_ROOT, "scripts/pw-scraper-runner.ts");

/**
 * Runs a Playwright scraper in a Node.js subprocess (via tsx).
 * This is necessary because Bun cannot launch Playwright browsers.
 * This function is only called from Bun — in Node.js the scrapers run directly.
 */
export async function runScraperInNode(
  scraperName: string
): Promise<RawListing[]> {
  console.log(`[${scraperName}] Delegating to Node.js subprocess...`);

  const proc = Bun.spawn(["npx", "tsx", RUNNER_SCRIPT, scraperName], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // 25s timeout — kill subprocess before the 30s refresh-level timeout
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    console.error(`[${scraperName}] Timed out after 25s — killed subprocess`);
  }, 25_000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;
  clearTimeout(timer);

  if (timedOut) return [];

  // Log stderr (contains console.log output from the scraper)
  if (stderr.trim()) {
    for (const line of stderr.trim().split("\n")) {
      console.log(line);
    }
  }

  // Extract JSON results between markers
  const startMarker = "__PW_RESULTS_START__";
  const endMarker = "__PW_RESULTS_END__";
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error(
      `[${scraperName}] No results markers found in output. stdout tail:`,
      stdout.slice(-500)
    );
    return [];
  }

  const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

  try {
    const results = JSON.parse(jsonStr) as RawListing[];
    return results;
  } catch (err) {
    console.error(
      `[${scraperName}] Failed to parse JSON results:`,
      (err as Error).message
    );
    return [];
  }
}
