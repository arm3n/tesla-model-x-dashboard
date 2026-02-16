/**
 * This script is executed by Node.js (via tsx) to run Playwright scrapers.
 * Bun cannot launch Playwright browsers due to a pipe communication bug,
 * so we delegate browser-based scraping to Node.js subprocesses.
 *
 * Usage: npx tsx scripts/pw-scraper-runner.ts <scraper-name>
 * Output: JSON array of RawListing[] on stdout
 */

const scraperName = process.argv[2];

if (!scraperName) {
  console.error("Usage: npx tsx scripts/pw-scraper-runner.ts <scraper-name>");
  process.exit(1);
}

async function run() {
  let results: any[];

  switch (scraperName) {
    case "carfax": {
      const { scrapeCarfax } = await import("../src/scraper/carfax.ts");
      results = await scrapeCarfax();
      break;
    }
    case "ebay": {
      const { scrapeEbayMotors } = await import("../src/scraper/ebay-motors.ts");
      results = await scrapeEbayMotors();
      break;
    }
    case "cars.com": {
      // Cars.com now uses direct fetch, no Playwright needed
      const { scrapeCarsCom } = await import("../src/scraper/cars-com.ts");
      results = await scrapeCarsCom();
      break;
    }
    case "cargurus": {
      const { scrapeCarGurus } = await import("../src/scraper/cargurus.ts");
      results = await scrapeCarGurus();
      break;
    }
    default:
      console.error(`Unknown scraper: ${scraperName}`);
      process.exit(1);
  }

  // Write results as JSON to stdout on a marked line so we can parse it
  // Use a unique delimiter to separate from console.log output
  process.stdout.write("\n__PW_RESULTS_START__\n");
  process.stdout.write(JSON.stringify(results));
  process.stdout.write("\n__PW_RESULTS_END__\n");
}

run().catch((err) => {
  console.error(`[pw-runner] Fatal error running ${scraperName}:`, err);
  process.stdout.write("\n__PW_RESULTS_START__\n[]\n__PW_RESULTS_END__\n");
  process.exit(0); // exit 0 so the parent doesn't crash
});
