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

const MAX_RETRIES = 1;
const SUSPECT_DURATION_MS = 2000; // 0 results in under 2s is suspicious

/**
 * Runs a Playwright scraper in a Node.js subprocess (via tsx).
 * This is necessary because Bun cannot launch Playwright browsers.
 * This function is only called from Bun — in Node.js the scrapers run directly.
 *
 * Throws on failure so the refresh pipeline can log it as an error.
 * Retries once if the subprocess fails or returns 0 results suspiciously fast.
 */
export async function runScraperInNode(
  scraperName: string
): Promise<RawListing[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const label = attempt > 0 ? `[${scraperName}] (retry ${attempt})` : `[${scraperName}]`;
    console.log(`${label} Delegating to Node.js subprocess...`);

    const startMs = Date.now();
    const proc = Bun.spawn(["npx", "tsx", RUNNER_SCRIPT, scraperName], {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    // 55s timeout — kill subprocess before the 60s refresh-level timeout
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 55_000);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timer);
    const durationMs = Date.now() - startMs;

    // Log stderr (contains console.log output from the scraper)
    if (stderr.trim()) {
      for (const line of stderr.trim().split("\n")) {
        console.log(line);
      }
    }

    if (timedOut) {
      throw new Error(`Subprocess timed out after 55s`);
    }

    if (exitCode !== 0) {
      const errTail = stderr.trim().slice(-300);
      if (attempt < MAX_RETRIES) {
        console.log(`${label} Subprocess exited with code ${exitCode}, retrying...`);
        continue;
      }
      throw new Error(`Subprocess exited with code ${exitCode}: ${errTail}`);
    }

    // Extract JSON results between markers
    const startMarker = "__PW_RESULTS_START__";
    const endMarker = "__PW_RESULTS_END__";
    const startIdx = stdout.indexOf(startMarker);
    const endIdx = stdout.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      const outTail = stdout.slice(-300);
      if (attempt < MAX_RETRIES) {
        console.log(`${label} No result markers in output, retrying...`);
        continue;
      }
      throw new Error(`No result markers in subprocess output. tail: ${outTail}`);
    }

    const jsonStr = stdout.slice(startIdx + startMarker.length, endIdx).trim();

    let results: RawListing[];
    try {
      results = JSON.parse(jsonStr) as RawListing[];
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`${label} Failed to parse JSON, retrying...`);
        continue;
      }
      throw new Error(`Failed to parse subprocess JSON: ${(err as Error).message}`);
    }

    // 0 results in under 2s is suspicious — likely a silent failure
    if (results.length === 0 && durationMs < SUSPECT_DURATION_MS) {
      if (attempt < MAX_RETRIES) {
        console.log(`${label} 0 results in ${durationMs}ms (suspicious), retrying...`);
        continue;
      }
      throw new Error(`0 results in ${durationMs}ms — likely failed silently`);
    }

    return results;
  }

  // Unreachable, but satisfy TypeScript
  return [];
}
