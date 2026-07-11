import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Locator, Page } from "playwright";
import { chromium } from "playwright";

const APP_NAME = "Brawl Stars Store Claimer";
const STORE_URL = "https://store.supercell.com/brawlstars";
const DEFAULT_PORT = 3100;
const DEFAULT_DATA_DIR = ".data/brawl-stars-claimer";
const DEFAULT_INTERVAL_MINUTES = 24 * 60;
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const SCREENSHOT_TIMEOUT_MS = 30_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 180_000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 1000;
const STATE_FILE = "claimer.json";
const CLAIM_FLAGS = new Set([
  "--claim-once",
  "--claim-supercell-reward",
  "--capture-once",
]);

type ClaimStatus = "claimed" | "no_reward" | "login_required" | "error";

type ClaimOffer = {
  title: string;
  url: string;
};

type ClaimResult = {
  status: ClaimStatus;
  claimed: boolean;
  loggedIn: boolean;
  message: string;
  checkedAt: string;
  sourceUrl: string;
  imageUrl?: string;
  offers: ClaimOffer[];
};

type ClaimState = {
  claiming: boolean;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  result?: ClaimResult;
};

type AppConfig = {
  accessPassword?: string;
  accessUsername?: string;
  authStateFile?: string;
  claimEnabled: boolean;
  claimTimeoutMs: number;
  dataDir: string;
  intervalMs: number;
  publicBasePath: string;
  refreshToken?: string;
  rewardSelectors: string[];
};

let claimState: ClaimState = {
  claiming: false,
};
let activeClaim: Promise<ClaimState> | null = null;

function readEnv(name: string, legacyName?: string) {
  return (
    process.env[name]?.trim() ||
    (legacyName ? process.env[legacyName]?.trim() : undefined) ||
    undefined
  );
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value === "true";
}

function normalizeBasePath(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "/") {
    return "";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function getConfig(): AppConfig {
  return {
    accessPassword: readEnv(
      "BRAWL_STARS_CLAIMER_ACCESS_PASSWORD",
      "MORNING_ACCESS_PASSWORD",
    ),
    accessUsername: readEnv(
      "BRAWL_STARS_CLAIMER_ACCESS_USERNAME",
      "MORNING_ACCESS_USERNAME",
    ),
    authStateFile: readEnv(
      "BRAWL_STARS_CLAIMER_AUTH_STATE_FILE",
      "MORNING_AUTH_STATE_FILE",
    ),
    claimEnabled: parseBoolean(
      readEnv("BRAWL_STARS_CLAIMER_ENABLED", "MORNING_CAPTURE_ENABLED"),
      false,
    ),
    claimTimeoutMs:
      Number(readEnv("BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS")) ||
      DEFAULT_CLAIM_TIMEOUT_MS,
    dataDir:
      readEnv("BRAWL_STARS_CLAIMER_DATA_DIR", "MORNING_SCREENSHOT_DIR") ||
      DEFAULT_DATA_DIR,
    intervalMs:
      Number(
        readEnv(
          "BRAWL_STARS_CLAIMER_INTERVAL_MINUTES",
          "MORNING_CAPTURE_INTERVAL_MINUTES",
        ),
      ) *
        60 *
        1000 || DEFAULT_INTERVAL_MINUTES * 60 * 1000,
    publicBasePath: normalizeBasePath(
      readEnv("BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH", "MORNING_PUBLIC_BASE_PATH"),
    ),
    refreshToken: readEnv(
      "BRAWL_STARS_CLAIMER_REFRESH_TOKEN",
      "MORNING_REFRESH_TOKEN",
    ),
    rewardSelectors: (
      readEnv(
        "BRAWL_STARS_CLAIMER_REWARD_SELECTORS",
        "MORNING_SUPERCELL_REWARD_SELECTORS",
      ) ||
      'button:has-text("Claim"),button:has-text("Collect"),[role="button"]:has-text("Claim"),[role="button"]:has-text("Collect")'
    )
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean),
  };
}

function statePath(config = getConfig()) {
  return join(config.dataDir, STATE_FILE);
}

function assetPath(config: AppConfig, filename: string) {
  return join(config.dataDir, filename);
}

function assetUrl(config: AppConfig, filename: string) {
  return `${config.publicBasePath}/assets/${encodeURIComponent(filename)}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactText(value: string, maxLength = 160) {
  const text = value.replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trim()}...`;
}

async function loadClaimState(config = getConfig()) {
  try {
    claimState = JSON.parse(
      await readFile(statePath(config), "utf8"),
    ) as ClaimState;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return claimState;
    }

    console.warn("Failed to read claim state:", error);
  }

  return claimState;
}

async function saveClaimState(nextState: ClaimState, config = getConfig()) {
  await mkdir(dirname(statePath(config)), { recursive: true });
  await writeFile(statePath(config), JSON.stringify(nextState, null, 2));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
) {
  let timeout: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function gotoStore(page: Page) {
  await page.goto(STORE_URL, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.waitForTimeout(2_000);
}

async function firstVisibleLocator(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible({ timeout: 1_500 })) {
        return locator;
      }
    } catch {
      // Try the next selector.
    }
  }

  return null;
}

async function screenshotTarget({
  config,
  filename,
  page,
  selectors,
}: {
  config: AppConfig;
  filename: string;
  page: Page;
  selectors: string[];
}) {
  await mkdir(config.dataDir, { recursive: true });
  const path = assetPath(config, filename);
  const target = await firstVisibleLocator(page, selectors);

  if (target) {
    try {
      await target.screenshot({ path, timeout: SCREENSHOT_TIMEOUT_MS });
      return assetUrl(config, filename);
    } catch {
      // Fall back to viewport screenshot.
    }
  }

  await page.screenshot({
    path,
    fullPage: false,
    timeout: SCREENSHOT_TIMEOUT_MS,
  });

  return assetUrl(config, filename);
}

async function extractOffers(page: Page): Promise<ClaimOffer[]> {
  const rawOffers = await page.locator("a[href*='/product/']").evaluateAll(
    (anchors) =>
      anchors.map((anchor) => {
        const element = anchor as HTMLAnchorElement;

        return {
          title:
            element.innerText?.trim() ||
            element.getAttribute("aria-label")?.trim() ||
            element.getAttribute("title")?.trim() ||
            "",
          url: element.href,
        };
      }),
  );
  const seenUrls = new Set<string>();
  const offers: ClaimOffer[] = [];

  for (const offer of rawOffers) {
    if (!offer.title || !offer.url || seenUrls.has(offer.url)) {
      continue;
    }

    seenUrls.add(offer.url);
    offers.push({
      title: compactText(offer.title),
      url: offer.url,
    });

    if (offers.length >= 4) {
      break;
    }
  }

  return offers;
}

async function clickRewardButton(rewardButton: Locator) {
  await rewardButton.click({ timeout: ACTION_TIMEOUT_MS });
  await rewardButton.page().waitForTimeout(2_000);
}

async function claimWithPage(
  page: Page,
  config: AppConfig,
): Promise<ClaimResult> {
  await gotoStore(page);

  const loginPrompt = await firstVisibleLocator(page, [
    'text="Log in to view offers"',
    'text="LOG IN TO VIEW OFFERS"',
    'button:has-text("Log in")',
    'button:has-text("LOG IN")',
  ]);
  const loggedIn = loginPrompt === null;
  const rewardButton = loggedIn
    ? await firstVisibleLocator(page, config.rewardSelectors)
    : null;
  let claimed = false;
  let status: ClaimStatus = loggedIn ? "no_reward" : "login_required";
  let message = loggedIn
    ? "No visible reward button found."
    : "Supercell Store is logged out. Refresh the saved auth state.";

  if (rewardButton) {
    await clickRewardButton(rewardButton);
    claimed = true;
    status = "claimed";
    message = "Reward button found and clicked.";
  }

  const offers = await extractOffers(page);
  const imageUrl = await screenshotTarget({
    config,
    filename: "brawl-stars-store.png",
    page,
    selectors: ["main", "body"],
  });

  return {
    status,
    claimed,
    loggedIn,
    message,
    checkedAt: new Date().toISOString(),
    sourceUrl: STORE_URL,
    imageUrl,
    offers,
  };
}

function errorResult(error: unknown): ClaimResult {
  return {
    status: "error",
    claimed: false,
    loggedIn: false,
    message: error instanceof Error ? error.message : "Unknown error",
    checkedAt: new Date().toISOString(),
    sourceUrl: STORE_URL,
    offers: [],
  };
}

async function claimBrawlStarsReward(config = getConfig()) {
  return withTimeout(
    (async () => {
      const browser = await chromium.launch({
        headless: true,
      });

      try {
        const contextOptions = {
          storageState: config.authStateFile,
          viewport: {
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT,
          },
        };
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

        try {
          return await claimWithPage(page, config);
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    })(),
    config.claimTimeoutMs,
    APP_NAME,
  ).catch(errorResult);
}

async function runClaimNow() {
  const config = getConfig();

  if (activeClaim) {
    return activeClaim;
  }

  activeClaim = (async () => {
    const startedAt = new Date().toISOString();
    claimState = {
      ...claimState,
      claiming: true,
      lastRunStartedAt: startedAt,
    };
    await saveClaimState(claimState, config);

    const result = await claimBrawlStarsReward(config);
    claimState = {
      claiming: false,
      lastRunStartedAt: startedAt,
      lastRunFinishedAt: new Date().toISOString(),
      result,
    };
    await saveClaimState(claimState, config);

    return claimState;
  })().finally(() => {
    activeClaim = null;
  });

  return activeClaim;
}

async function getClaimState() {
  await loadClaimState();

  return {
    ...claimState,
    claiming: Boolean(activeClaim) || claimState.claiming,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function isRefreshAuthorized(request: Request, config: AppConfig) {
  if (!config.refreshToken) {
    return true;
  }

  return request.headers.get("authorization") === `Bearer ${config.refreshToken}`;
}

function getBasicAuthCredentials(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  const decoded = atob(authorization.slice("Basic ".length));
  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
}

function isAccessAuthorized(request: Request, config: AppConfig) {
  if (!config.accessUsername || !config.accessPassword) {
    return true;
  }

  const credentials = getBasicAuthCredentials(request);

  return (
    credentials?.username === config.accessUsername &&
    credentials.password === config.accessPassword
  );
}

function unauthorizedResponse() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": `Basic realm="${APP_NAME}"`,
    },
  });
}

function renderStatusBadge(result: ClaimResult | undefined) {
  const label = result?.status.replaceAll("_", " ") || "not run";

  return `<span class="badge" data-status="${escapeHtml(result?.status || "idle")}">${escapeHtml(label)}</span>`;
}

function renderOffers(offers: ClaimOffer[]) {
  if (offers.length === 0) {
    return '<p class="empty">No store product links captured.</p>';
  }

  return `<ul class="offers">${offers
    .map(
      (offer) => `<li>
        <a href="${escapeHtml(offer.url)}">${escapeHtml(offer.title)}</a>
      </li>`,
    )
    .join("")}</ul>`;
}

function renderPage(state: ClaimState, config: AppConfig) {
  const result = state.result;
  const image = result?.imageUrl
    ? `<a class="preview" href="${escapeHtml(STORE_URL)}"><img src="${escapeHtml(result.imageUrl)}?t=${encodeURIComponent(result.checkedAt)}" alt="Brawl Stars Store preview" loading="lazy"></a>`
    : '<div class="preview empty-preview">No screenshot yet</div>';
  const checkedAt = result?.checkedAt
    ? new Date(result.checkedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "Asia/Taipei",
      })
    : "Never";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${APP_NAME}</title>
  <style>
    :root {
      --color-bg: #111315;
      --color-surface: #191b1f;
      --color-surface-raised: #20242a;
      --color-border: #343842;
      --color-text: #edf4ef;
      --color-muted: #a5abb7;
      --color-accent: #8ab4ff;
      --color-success: #80d39b;
      --color-warning: #ffd166;
      --color-error: #ff8a80;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-6: 24px;
      --space-8: 32px;
      --radius-card: 8px;
      --radius-pill: 999px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1040px, 100%);
      margin: 0 auto;
      padding: var(--space-8);
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: end;
      margin-bottom: var(--space-6);
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.2; }
    h2 { font-size: 18px; line-height: 1.25; }
    a { color: var(--color-accent); }
    button {
      min-height: 40px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface-raised);
      color: var(--color-text);
      padding: 0 var(--space-4);
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { border-color: var(--color-accent); }
    .subtle, .empty, .meta, .message { color: var(--color-muted); }
    .panel {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: center;
      padding: var(--space-4);
      border-bottom: 1px solid var(--color-border);
    }
    .content {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: var(--space-4);
      padding: var(--space-4);
    }
    .preview {
      min-height: 320px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-bg);
      overflow: hidden;
    }
    .preview img {
      display: block;
      width: 100%;
      height: auto;
    }
    .empty-preview {
      display: grid;
      place-items: center;
      color: var(--color-muted);
    }
    .details {
      display: grid;
      align-content: start;
      gap: var(--space-4);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      width: fit-content;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pill);
      padding: 0 var(--space-3);
      text-transform: capitalize;
    }
    .badge[data-status="claimed"] { color: var(--color-success); }
    .badge[data-status="login_required"],
    .badge[data-status="no_reward"] { color: var(--color-warning); }
    .badge[data-status="error"] { color: var(--color-error); }
    .offers {
      margin: 0;
      padding-left: var(--space-6);
    }
    @media (max-width: 760px) {
      main { padding: var(--space-4); }
      header, .toolbar {
        display: grid;
        align-items: start;
      }
      .content { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${APP_NAME}</h1>
        <p class="subtle">Brawl Stars daily store reward claim status.</p>
      </div>
      <a href="${STORE_URL}">Open store</a>
    </header>
    <section class="panel">
      <div class="toolbar">
        <div>
          <h2>Claim Status</h2>
          <p class="meta">Last checked: ${escapeHtml(checkedAt)}</p>
        </div>
        <form method="post" action="${config.publicBasePath}/api/claim">
          <button type="submit">${state.claiming ? "Claiming..." : "Claim now"}</button>
        </form>
      </div>
      <div class="content">
        ${image}
        <div class="details">
          ${renderStatusBadge(result)}
          <p class="message">${escapeHtml(result?.message || "No claim has run yet.")}</p>
          <div>
            <h2>Captured Offers</h2>
            ${renderOffers(result?.offers || [])}
          </div>
          <p class="meta">Logged in: ${result ? (result.loggedIn ? "yes" : "no") : "unknown"}</p>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`;
}

async function handleRequest(request: Request) {
  const config = getConfig();
  const url = new URL(request.url);
  const pathname = url.pathname.replace(config.publicBasePath, "") || "/";

  if (pathname === "/api/health") {
    return jsonResponse({
      ok: true,
      claiming: Boolean(activeClaim) || claimState.claiming,
    });
  }

  if (!isAccessAuthorized(request, config)) {
    return unauthorizedResponse();
  }

  if (request.method === "GET" && pathname === "/api/status") {
    return jsonResponse(await getClaimState());
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/claim" || pathname === "/api/refresh")
  ) {
    if (!isRefreshAuthorized(request, config)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const nextState = await runClaimNow();
    const accept = request.headers.get("accept") || "";

    if (accept.includes("text/html")) {
      return Response.redirect(`${url.origin}${config.publicBasePath}/`, 303);
    }

    return jsonResponse({ ok: true, state: nextState });
  }

  if (request.method === "GET" && pathname.startsWith("/assets/")) {
    const filename = decodeURIComponent(pathname.slice("/assets/".length));
    const path = assetPath(config, filename);
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: {
        "cache-control": "no-store",
        "content-type": filename.endsWith(".png") ? "image/png" : "text/plain",
      },
    });
  }

  if (request.method === "GET" && pathname === "/") {
    return new Response(renderPage(await getClaimState(), config), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function startScheduler() {
  const config = getConfig();

  await loadClaimState(config);

  if (!config.claimEnabled) {
    return;
  }

  void runClaimNow().catch((error) => {
    console.error("Brawl Stars claim failed:", error);
  });

  setInterval(() => {
    void runClaimNow().catch((error) => {
      console.error("Brawl Stars claim failed:", error);
    });
  }, config.intervalMs);

  console.log(
    `Brawl Stars claimer enabled every ${Math.round(
      config.intervalMs / 60_000,
    )} minutes.`,
  );
}

if (process.argv.some((argument) => CLAIM_FLAGS.has(argument))) {
  const nextState = await runClaimNow();

  console.log(JSON.stringify(nextState.result, null, 2));
  process.exit(nextState.result?.status === "error" ? 1 : 0);
}

const port = Number(process.env.PORT || DEFAULT_PORT);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const server = Bun.serve({
  port,
  hostname,
  fetch: handleRequest,
});

await startScheduler();

console.log(`${APP_NAME} listening on http://${server.hostname}:${server.port}`);
