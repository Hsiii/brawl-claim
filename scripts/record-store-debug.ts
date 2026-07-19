import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";

const STORE_URL = "https://store.supercell.com/brawlstars";
const dataDir = process.env.BRAWL_CLAIM_DATA_DIR || "/app/state";
const authState = process.env.BRAWL_CLAIM_AUTH_STATE || join(dataDir, "auth.json");
const outputDir =
  process.env.BRAWL_CLAIM_DEBUG_OUTPUT_DIR || join(dataDir, "debug-recordings");
const timestamp = new Date().toISOString().replaceAll(":", "-");
const screenshotPath = join(outputDir, `store-${timestamp}.png`);

await mkdir(outputDir, { recursive: true });

const startedAt = performance.now();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordVideo: {
    dir: outputDir,
    size: { width: 1440, height: 1000 },
  },
  storageState: authState,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const video = page.video();

try {
  console.log("Opening the Supercell Store");
  await page.goto(STORE_URL, { timeout: 45_000, waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);

  const bodyText = await page.locator("body").innerText({ timeout: 8_000 });
  const matchingLines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(?:claim|collect)\b/i.test(line));
  console.log(`Matching visible text: ${JSON.stringify(matchingLines)}`);

  for (const [index, frame] of page.frames().entries()) {
    const controls = frame.locator("button,[role='button']");
    const scanStartedAt = performance.now();
    const matchIndex = await controls.evaluateAll((elements) =>
      elements.slice(0, 100).findIndex((element) => {
        const control = element as HTMLButtonElement;
        const label = (element.textContent || "").replace(/\s+/g, " ").trim();

        return Boolean(
          /\b(?:claim|collect)\b/i.test(label) &&
            !element.closest("[hidden],[aria-hidden='true']") &&
            !control.disabled &&
            element.getAttribute("aria-disabled") !== "true",
        );
      }),
    );

    console.log(
      `Frame ${index} reward scan: ${matchIndex} in ${Math.round(performance.now() - scanStartedAt)}ms`,
    );
  }

  await page.screenshot({ fullPage: true, path: screenshotPath, timeout: 8_000 });
  console.log(`Screenshot: ${screenshotPath}`);
} finally {
  await context.close();
  await browser.close();
}

console.log(`Video: ${await video?.path()}`);
console.log(`Finished in ${Math.round(performance.now() - startedAt)}ms`);
