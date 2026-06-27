import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Browser, Page } from "playwright";
import { chromium } from "playwright";

const DEFAULT_PORT = 3100;
const DEFAULT_SCREENSHOT_DIR = ".data/screenshots";
const DEFAULT_CAPTURE_INTERVAL_MINUTES = 180;
const CAPTURE_TIMEOUT_MS = 45_000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;
const METADATA_FILE = "metadata.json";

type FeedTarget = {
  name: string;
  url: string;
  collectDailyReward?: boolean;
};

type AppConfig = {
  captureEnabled: boolean;
  intervalMs: number;
  screenshotDir: string;
  authStateFile?: string;
  refreshToken?: string;
  supercellRewardEnabled: boolean;
  supercellRewardSelectors: string[];
  targets: FeedTarget[];
};

type CaptureResult = {
  name: string;
  url: string;
  slug: string;
  status: "ok" | "error";
  capturedAt: string;
  imageUrl?: string;
  title?: string;
  error?: string;
  rewardAttempted?: boolean;
  rewardCollected?: boolean;
};

type CaptureMetadata = {
  capturing: boolean;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  results: CaptureResult[];
};

const defaultTargets = [
  ["Instagram", "https://www.instagram.com/"],
  ["Messenger", "https://www.messenger.com/"],
  ["Twitter", "https://twitter.com/home"],
  ["Facebook", "https://zh-tw.facebook.com/"],
  ["GitHub", "https://github.com/"],
  ["Crx", "https://chrome.google.com/webstore/devconsole/"],
  ["YouTube", "https://www.youtube.com/"],
  ["Anigamer", "https://ani.gamer.com.tw/"],
  ["Supercell Store", "https://store.supercell.com/brawlstars"],
] as const;

let metadata: CaptureMetadata = {
  capturing: false,
  results: [],
};
let activeCapture: Promise<CaptureMetadata> | null = null;

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value === "true";
}

function parseTargets(value: string | undefined): FeedTarget[] {
  if (!value?.trim()) {
    return defaultTargets.map(([name, url]) => ({
      name,
      url,
      collectDailyReward: name === "Supercell Store",
    }));
  }

  const parsed = JSON.parse(value) as FeedTarget[];

  if (!Array.isArray(parsed)) {
    throw new Error("MORNING_TARGETS must be a JSON array.");
  }

  return parsed.map((target) => {
    if (!target.name?.trim() || !target.url?.trim()) {
      throw new Error("Each MORNING_TARGETS item needs name and url.");
    }

    return {
      name: target.name.trim(),
      url: target.url.trim(),
      collectDailyReward: target.collectDailyReward === true,
    };
  });
}

function getConfig(): AppConfig {
  return {
    captureEnabled: parseBoolean(process.env.MORNING_CAPTURE_ENABLED, true),
    intervalMs:
      Number(process.env.MORNING_CAPTURE_INTERVAL_MINUTES) *
        60 *
        1000 || DEFAULT_CAPTURE_INTERVAL_MINUTES * 60 * 1000,
    screenshotDir:
      process.env.MORNING_SCREENSHOT_DIR?.trim() || DEFAULT_SCREENSHOT_DIR,
    authStateFile: process.env.MORNING_AUTH_STATE_FILE?.trim() || undefined,
    refreshToken: process.env.MORNING_REFRESH_TOKEN?.trim() || undefined,
    supercellRewardEnabled: parseBoolean(
      process.env.MORNING_SUPERCELL_REWARD_ENABLED,
      false,
    ),
    supercellRewardSelectors: (
      process.env.MORNING_SUPERCELL_REWARD_SELECTORS ||
      'button:has-text("Claim"),button:has-text("Collect"),text=Claim,text=Collect'
    )
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean),
    targets: parseTargets(process.env.MORNING_TARGETS),
  };
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "feed"
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function metadataPath(config = getConfig()) {
  return join(config.screenshotDir, METADATA_FILE);
}

async function loadMetadata(config = getConfig()) {
  try {
    metadata = JSON.parse(
      await readFile(metadataPath(config), "utf8"),
    ) as CaptureMetadata;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return metadata;
    }

    console.warn("Failed to read screenshot metadata:", error);
  }

  return metadata;
}

async function saveMetadata(
  nextMetadata: CaptureMetadata,
  config = getConfig(),
) {
  await mkdir(dirname(metadataPath(config)), { recursive: true });
  await writeFile(metadataPath(config), JSON.stringify(nextMetadata, null, 2));
}

async function collectDailyReward({
  page,
  selectors,
}: {
  page: Page;
  selectors: string[];
}) {
  for (const selector of selectors) {
    try {
      await page.locator(selector).first().click({ timeout: 3_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 });

      return true;
    } catch {
      // Store copy varies by locale and reward state.
    }
  }

  return false;
}

async function captureTarget({
  browser,
  config,
  target,
}: {
  browser: Browser;
  config: AppConfig;
  target: FeedTarget;
}): Promise<CaptureResult> {
  const slug = slugify(target.name);
  const capturedAt = new Date().toISOString();
  const context = await browser.newContext({
    storageState: config.authStateFile,
    viewport: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
    },
  });
  const page = await context.newPage();

  try {
    await page.goto(target.url, {
      waitUntil: "networkidle",
      timeout: CAPTURE_TIMEOUT_MS,
    });

    const rewardAttempted =
      target.collectDailyReward && config.supercellRewardEnabled;
    const rewardCollected = rewardAttempted
      ? await collectDailyReward({
          page,
          selectors: config.supercellRewardSelectors,
        })
      : undefined;
    const title = await page.title();

    await mkdir(config.screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(config.screenshotDir, `${slug}.png`),
      fullPage: false,
    });

    return {
      name: target.name,
      url: target.url,
      slug,
      status: "ok",
      capturedAt,
      imageUrl: `/assets/${slug}.png`,
      title,
      rewardAttempted,
      rewardCollected,
    };
  } catch (error) {
    return {
      name: target.name,
      url: target.url,
      slug,
      status: "error",
      capturedAt,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  } finally {
    await context.close();
  }
}

async function captureNow() {
  const config = getConfig();

  if (activeCapture) {
    return activeCapture;
  }

  activeCapture = (async () => {
    metadata = {
      ...metadata,
      capturing: true,
      lastRunStartedAt: new Date().toISOString(),
    };
    await saveMetadata(metadata, config);

    const browser = await chromium.launch({
      headless: true,
    });
    const results: CaptureResult[] = [];

    try {
      for (const target of config.targets) {
        results.push(await captureTarget({ browser, config, target }));
      }
    } finally {
      await browser.close();
    }

    metadata = {
      capturing: false,
      lastRunStartedAt: metadata.lastRunStartedAt,
      lastRunFinishedAt: new Date().toISOString(),
      results,
    };
    await saveMetadata(metadata, config);

    return metadata;
  })().finally(() => {
    activeCapture = null;
  });

  return activeCapture;
}

async function getMetadata() {
  await loadMetadata();

  return {
    ...metadata,
    capturing: Boolean(activeCapture) || metadata.capturing,
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

function renderDashboard(current: CaptureMetadata) {
  const cards = current.results
    .map((result) => {
      const image = result.imageUrl
        ? `<a class="image-link" href="${escapeHtml(result.url)}"><img src="${escapeHtml(result.imageUrl)}?t=${encodeURIComponent(result.capturedAt)}" alt="${escapeHtml(result.name)} screenshot" loading="lazy"></a>`
        : '<div class="placeholder">No screenshot</div>';
      const reward =
        result.rewardAttempted === true
          ? `<span class="pill">${result.rewardCollected ? "Reward clicked" : "Reward not found"}</span>`
          : "";

      return `<article class="card">
        <div class="card-header">
          <div>
            <h2>${escapeHtml(result.name)}</h2>
            <a href="${escapeHtml(result.url)}">${escapeHtml(result.title || result.url)}</a>
          </div>
          <span class="status ${result.status}">${result.status}</span>
        </div>
        ${image}
        <div class="meta">
          <time datetime="${escapeHtml(result.capturedAt)}">${escapeHtml(new Date(result.capturedAt).toLocaleString())}</time>
          ${reward}
        </div>
        ${result.error ? `<p class="error">${escapeHtml(result.error)}</p>` : ""}
      </article>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Morning Dashboard</title>
  <style>
    :root {
      --color-bg: #111315;
      --color-surface: #191b1f;
      --color-border: #343842;
      --color-text: #edf4ef;
      --color-muted: #a5abb7;
      --color-accent: #8ab4ff;
      --color-success: #80d39b;
      --color-error: #ff8a80;
      --space-1: 4px;
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
      font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1440px, 100%);
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
    h2 { font-size: 20px; line-height: 1.3; }
    a { color: var(--color-accent); overflow-wrap: anywhere; }
    button {
      min-height: 40px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      color: var(--color-text);
      padding: 0 var(--space-4);
      cursor: pointer;
    }
    button:hover { border-color: var(--color-accent); }
    .subtle { color: var(--color-muted); margin-top: var(--space-2); }
    .actions {
      display: flex;
      gap: var(--space-2);
      align-items: center;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: var(--space-4);
    }
    .card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      overflow: hidden;
    }
    .card-header {
      min-height: 96px;
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4);
    }
    .status, .pill {
      height: 28px;
      display: inline-flex;
      align-items: center;
      padding: 0 var(--space-2);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-pill);
      color: var(--color-muted);
      white-space: nowrap;
    }
    .status.ok { color: var(--color-success); }
    .status.error, .error { color: var(--color-error); }
    .image-link, .placeholder {
      display: block;
      aspect-ratio: 16 / 10;
      border-top: 1px solid var(--color-border);
      border-bottom: 1px solid var(--color-border);
      background: var(--color-bg);
    }
    img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      object-position: top center;
    }
    .placeholder {
      display: grid;
      place-items: center;
      color: var(--color-muted);
    }
    .meta {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-4);
      color: var(--color-muted);
    }
    .error { padding: 0 var(--space-4) var(--space-4); }
    @media (max-width: 720px) {
      main { padding: var(--space-4); }
      header, .card-header, .meta { display: block; }
      .actions { margin-top: var(--space-4); }
      .grid { grid-template-columns: 1fr; }
      .status, .pill { margin-top: var(--space-2); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Morning Dashboard</h1>
        <p class="subtle">${current.capturing ? "Capture running" : "Last updated"}${current.lastRunFinishedAt ? ` ${escapeHtml(new Date(current.lastRunFinishedAt).toLocaleString())}` : ""}</p>
      </div>
      <div class="actions">
        <a href="/api/screenshots">JSON</a>
        <form method="post" action="/api/refresh"><button type="submit">Refresh</button></form>
      </div>
    </header>
    <section class="grid">${cards || '<p class="subtle">No screenshots captured yet.</p>'}</section>
  </main>
</body>
</html>`;
}

async function handleRequest(request: Request) {
  const config = getConfig();
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return jsonResponse({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/screenshots") {
    return jsonResponse(await getMetadata());
  }

  if (request.method === "POST" && url.pathname === "/api/refresh") {
    if (!isRefreshAuthorized(request, config)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const nextMetadata = await captureNow();
    const accept = request.headers.get("accept") || "";

    if (accept.includes("text/html")) {
      return Response.redirect(new URL("/", request.url), 303);
    }

    return jsonResponse({ ok: true, metadata: nextMetadata });
  }

  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const slug = url.pathname.slice("/assets/".length).replace(/\.png$/, "");
    const file = Bun.file(join(config.screenshotDir, `${slugify(slug)}.png`));

    if (!(await file.exists())) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(file, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "image/png",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(renderDashboard(await getMetadata()), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function startScheduler() {
  const config = getConfig();

  await loadMetadata(config);

  if (!config.captureEnabled) {
    return;
  }

  void captureNow().catch((error) => {
    console.error("Screenshot capture failed:", error);
  });

  setInterval(() => {
    void captureNow().catch((error) => {
      console.error("Screenshot capture failed:", error);
    });
  }, config.intervalMs);

  console.log(
    `Screenshot capture enabled every ${Math.round(
      config.intervalMs / 60_000,
    )} minutes.`,
  );
}

if (process.argv.includes("--capture-once")) {
  await captureNow();
  process.exit(0);
}

const port = Number(process.env.PORT || DEFAULT_PORT);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const server = Bun.serve({
  port,
  hostname,
  fetch: handleRequest,
});

await startScheduler();

console.log(`Morning Dashboard listening on http://${server.hostname}:${server.port}`);
