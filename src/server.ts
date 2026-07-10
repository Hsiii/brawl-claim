import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Browser, Locator, Page } from "playwright";
import { chromium } from "playwright";

const DEFAULT_PORT = 3100;
const DEFAULT_DATA_DIR = ".data/dashboard";
const DEFAULT_COLLECT_INTERVAL_MINUTES = 180;
const DEFAULT_ENABLED_SOURCES = [
  "x",
  "instagram",
  "messenger",
  "facebook",
  "anigamer",
  "supercell",
  "youtube",
] as const;
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SOURCE_TIMEOUT_MS = 60_000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 1000;
const STATE_FILE = "dashboard.json";
const CLAIM_SUPERCELL_REWARD_FLAG = "--claim-supercell-reward";

type SourceId = (typeof DEFAULT_ENABLED_SOURCES)[number];

type DashboardItem = {
  title: string;
  url: string;
  subtitle?: string;
  summary?: string;
  timestamp?: string;
};

type DashboardSection = {
  id: SourceId;
  title: string;
  sourceUrl: string;
  status: "ok" | "empty" | "error" | "config";
  collectedAt: string;
  items: DashboardItem[];
  imageUrl?: string;
  message?: string;
};

type DashboardState = {
  collecting: boolean;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  sections: DashboardSection[];
};

type AppConfig = {
  accessPassword?: string;
  accessUsername?: string;
  authStateFile?: string;
  collectEnabled: boolean;
  dataDir: string;
  enabledSources: Set<SourceId>;
  intervalMs: number;
  publicBasePath: string;
  refreshToken?: string;
  supercellRewardEnabled: boolean;
  supercellRewardSelectors: string[];
};

type LinkCandidate = {
  title: string;
  url: string;
  subtitle?: string;
};

const sourceMeta = {
  anigamer: {
    title: "Anigamer Notifications",
    sourceUrl: "https://ani.gamer.com.tw/",
  },
  facebook: {
    title: "Facebook Notifications",
    sourceUrl: "https://www.facebook.com/",
  },
  instagram: {
    title: "Instagram DM Preview",
    sourceUrl: "https://www.instagram.com/direct/inbox/",
  },
  messenger: {
    title: "Messenger Preview",
    sourceUrl: "https://www.messenger.com/",
  },
  supercell: {
    title: "Supercell Store Reward",
    sourceUrl: "https://store.supercell.com/brawlstars",
  },
  x: {
    title: "X Timeline",
    sourceUrl: "https://twitter.com/home",
  },
  youtube: {
    title: "YouTube Recommendations",
    sourceUrl: "https://www.youtube.com/",
  },
} satisfies Record<SourceId, { title: string; sourceUrl: string }>;

let dashboardState: DashboardState = {
  collecting: false,
  sections: [],
};
let activeCollection: Promise<DashboardState> | null = null;

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

function parseEnabledSources(value: string | undefined) {
  const requestedSources = value?.trim()
    ? value.split(",").map((source) => source.trim().toLowerCase())
    : DEFAULT_ENABLED_SOURCES;
  const knownSources = new Set<string>(DEFAULT_ENABLED_SOURCES);

  return new Set(
    requestedSources.filter((source): source is SourceId =>
      knownSources.has(source),
    ),
  );
}

function getConfig(): AppConfig {
  return {
    accessPassword: process.env.MORNING_ACCESS_PASSWORD?.trim() || undefined,
    accessUsername: process.env.MORNING_ACCESS_USERNAME?.trim() || undefined,
    authStateFile: process.env.MORNING_AUTH_STATE_FILE?.trim() || undefined,
    collectEnabled: parseBoolean(process.env.MORNING_CAPTURE_ENABLED, true),
    dataDir: process.env.MORNING_SCREENSHOT_DIR?.trim() || DEFAULT_DATA_DIR,
    enabledSources: parseEnabledSources(process.env.MORNING_ENABLED_SOURCES),
    intervalMs:
      Number(process.env.MORNING_CAPTURE_INTERVAL_MINUTES) *
        60 *
        1000 || DEFAULT_COLLECT_INTERVAL_MINUTES * 60 * 1000,
    publicBasePath: normalizeBasePath(process.env.MORNING_PUBLIC_BASE_PATH),
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

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compactText(value: string, maxLength = 180) {
  const text = value.replace(/\s+/g, " ").trim();

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function section({
  id,
  status,
  items = [],
  imageUrl,
  message,
}: {
  id: SourceId;
  status: DashboardSection["status"];
  items?: DashboardItem[];
  imageUrl?: string;
  message?: string;
}): DashboardSection {
  return {
    id,
    title: sourceMeta[id].title,
    sourceUrl: sourceMeta[id].sourceUrl,
    status,
    collectedAt: new Date().toISOString(),
    items,
    imageUrl,
    message,
  };
}

function errorSection(id: SourceId, error: unknown): DashboardSection {
  return section({
    id,
    status: "error",
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

async function loadDashboardState(config = getConfig()) {
  try {
    dashboardState = JSON.parse(
      await readFile(statePath(config), "utf8"),
    ) as DashboardState;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return dashboardState;
    }

    console.warn("Failed to read dashboard state:", error);
  }

  return dashboardState;
}

async function saveDashboardState(
  nextState: DashboardState,
  config = getConfig(),
) {
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

async function goto(page: Page, url: string) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  await page.waitForTimeout(2_000);
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();

    try {
      if (await locator.isVisible({ timeout: 1_500 })) {
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        return true;
      }
    } catch {
      // Try the next selector.
    }
  }

  return false;
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
      await target.screenshot({ path });
      return assetUrl(config, filename);
    } catch {
      // Fall back to viewport screenshot.
    }
  }

  await page.screenshot({ path, fullPage: false });

  return assetUrl(config, filename);
}

async function extractLinksFromLocator(
  locator: Locator,
  maxItems: number,
): Promise<LinkCandidate[]> {
  const rawLinks = await locator.locator("a[href]").evaluateAll(
    (anchors, limit) =>
      anchors
        .map((anchor) => {
          const element = anchor as HTMLAnchorElement;
          const title =
            element.innerText?.trim() ||
            element.getAttribute("aria-label")?.trim() ||
            element.getAttribute("title")?.trim() ||
            "";

          return {
            title,
            url: element.href,
          };
        })
        .filter((item) => item.title && item.url)
        .slice(0, limit * 3),
    maxItems,
  );
  const seenUrls = new Set<string>();
  const items: LinkCandidate[] = [];

  for (const link of rawLinks) {
    if (seenUrls.has(link.url)) {
      continue;
    }

    seenUrls.add(link.url);
    items.push({
      title: compactText(link.title, 140),
      url: link.url,
    });

    if (items.length >= maxItems) {
      break;
    }
  }

  return items;
}

async function collectWithPage(
  browser: Browser,
  config: AppConfig,
  id: SourceId,
  collect: (page: Page) => Promise<DashboardSection>,
) {
  return withTimeout(
    (async () => {
      const context = await browser.newContext({
        storageState: config.authStateFile,
        viewport: {
          width: VIEWPORT_WIDTH,
          height: VIEWPORT_HEIGHT,
        },
      });
      const page = await context.newPage();

      page.setDefaultTimeout(ACTION_TIMEOUT_MS);

      try {
        return await collect(page);
      } catch (error) {
        return errorSection(id, error);
      } finally {
        await context.close();
      }
    })(),
    SOURCE_TIMEOUT_MS,
    sourceMeta[id].title,
  ).catch((error) => errorSection(id, error));
}

async function collectXTimeline(
  page: Page,
  config: AppConfig,
): Promise<DashboardSection> {
  await goto(page, sourceMeta.x.sourceUrl);
  await page
    .locator('article a[href*="/status/"]')
    .first()
    .waitFor({ timeout: 12_000 })
    .catch(() => undefined);

  const rawPosts = await page.locator("article").evaluateAll((articles) =>
    articles.map((article) => {
      const statusLink = article.querySelector(
        'a[href*="/status/"]',
      ) as HTMLAnchorElement | null;
      const text = (article as HTMLElement).innerText?.trim() || "";

      return {
        text,
        url: statusLink?.href || "",
      };
    }),
  );
  const seenUrls = new Set<string>();
  const items: DashboardItem[] = [];

  for (const post of rawPosts) {
    if (!post.url || seenUrls.has(post.url)) {
      continue;
    }

    seenUrls.add(post.url);
    items.push({
      title: compactText(post.text, 140) || "X post",
      url: post.url,
      summary: post.text,
    });

    if (items.length >= 12) {
      break;
    }
  }

  const imageUrl = await screenshotTarget({
    config,
    filename: "x-timeline.png",
    page,
    selectors: ['main[role="main"]', '[data-testid="primaryColumn"]', "main"],
  });

  return section({
    id: "x",
    status: items.length ? "ok" : "empty",
    imageUrl,
    items,
    message: items.length
      ? "Extracted visible post links from the logged-in timeline."
      : "No visible timeline posts found.",
  });
}

async function collectInstagramDmPreview(
  page: Page,
  config: AppConfig,
): Promise<DashboardSection> {
  await goto(page, "https://www.instagram.com/");

  const clicked = await clickFirstVisible(page, [
    'a[href="/direct/inbox/"]',
    'a[href*="/direct/inbox"]',
    '[aria-label="Messenger"]',
    '[aria-label="Direct"]',
  ]);

  if (!clicked) {
    await goto(page, sourceMeta.instagram.sourceUrl);
  } else {
    await page.waitForTimeout(2_500);
  }

  const imageUrl = await screenshotTarget({
    config,
    filename: "instagram-dms.png",
    page,
    selectors: [
      'main[role="main"]',
      '[role="main"]',
      'div:has-text("Messages")',
      "main",
      "body",
    ],
  });

  return section({
    id: "instagram",
    status: "ok",
    imageUrl,
    items: [
      {
        title: "Open Instagram inbox locally",
        url: sourceMeta.instagram.sourceUrl,
      },
    ],
    message: "Captured inbox/list preview only. No conversation rows clicked.",
  });
}

async function collectMessengerPreview(
  page: Page,
  config: AppConfig,
): Promise<DashboardSection> {
  await goto(page, sourceMeta.messenger.sourceUrl);

  const imageUrl = await screenshotTarget({
    config,
    filename: "messenger-preview.png",
    page,
    selectors: [
      '[aria-label="Chats"]',
      '[aria-label="聊天"]',
      '[role="navigation"]',
      '[role="main"]',
      "body",
    ],
  });

  return section({
    id: "messenger",
    status: "ok",
    imageUrl,
    items: [
      {
        title: "Open Messenger locally",
        url: sourceMeta.messenger.sourceUrl,
      },
    ],
    message: "Captured chat list preview only. No chat rows clicked.",
  });
}

async function collectFacebookNotifications(
  page: Page,
  config: AppConfig,
): Promise<DashboardSection> {
  await goto(page, sourceMeta.facebook.sourceUrl);

  const clickedNotifications = await clickFirstVisible(page, [
    '[aria-label="Notifications"][role="button"]',
    '[aria-label="通知"][role="button"]',
    'div[role="button"][aria-label*="Notifications"]',
    'div[role="button"][aria-label*="通知"]',
    'a[aria-label*="Notifications"]',
    'a[aria-label*="通知"]',
  ]);
  await page.waitForTimeout(2_000);

  if (!clickedNotifications) {
    const imageUrl = await screenshotTarget({
      config,
      filename: "facebook-notifications.png",
      page,
      selectors: ["body"],
    });

    return section({
      id: "facebook",
      status: "config",
      imageUrl,
      message:
        "Could not find the notifications button. Saved Playwright auth state is probably missing or expired.",
    });
  }

  const panel =
    (await firstVisibleLocator(page, [
      'div[role="dialog"]',
      '[aria-label="Notifications"]',
      '[aria-label="通知"]',
      '[role="main"]',
    ])) ?? undefined;

  if (!panel) {
    return section({
      id: "facebook",
      status: "empty",
      message: "Notifications panel did not open.",
    });
  }

  const links = await extractLinksFromLocator(panel, 12);
  const imageUrl = await screenshotTarget({
    config,
    filename: "facebook-notifications.png",
    page,
    selectors: [
      'div[role="dialog"]',
      '[aria-label="Notifications"]',
      '[aria-label="通知"]',
      "body",
    ],
  });

  return section({
    id: "facebook",
    status: links.length ? "ok" : "empty",
    imageUrl,
    items: links,
    message: links.length
      ? "Notification links extracted without opening individual notifications."
      : "No notification links found.",
  });
}

async function collectAnigamerNotifications(page: Page): Promise<DashboardSection> {
  await goto(page, sourceMeta.anigamer.sourceUrl);

  await clickFirstVisible(page, [
    'text="通知"',
    'a:has-text("通知")',
    'button:has-text("通知")',
    '[aria-label*="通知"]',
  ]);
  await page.waitForTimeout(1_500);

  const links = (await extractLinksFromLocator(page.locator("body"), 16))
    .filter((link) =>
      /更新|通知|站內信|公告|小時前|天前|分鐘前/.test(link.title),
    )
    .slice(0, 12);

  return section({
    id: "anigamer",
    status: links.length ? "ok" : "empty",
    items: links,
    message: links.length
      ? "Read notification panel links without opening each notification."
      : "No Anigamer notifications found.",
  });
}

async function collectSupercellReward(
  page: Page,
  config: AppConfig,
): Promise<DashboardSection> {
  await goto(page, sourceMeta.supercell.sourceUrl);

  const rewardButton = await firstVisibleLocator(
    page,
    config.supercellRewardSelectors,
  );
  let rewardMessage = "No visible reward button found in the top section.";
  let rewardCollected = false;

  if (rewardButton) {
    rewardMessage = config.supercellRewardEnabled
      ? "Reward button found and clicked."
      : "Reward button found. Auto-collection is disabled.";

    if (config.supercellRewardEnabled) {
      await rewardButton.click({ timeout: ACTION_TIMEOUT_MS });
      await page.waitForTimeout(2_000);
      rewardCollected = true;
    }
  }

  const offers = (await extractLinksFromLocator(page.locator("body"), 8))
    .filter((link) => link.url.includes("/product/"))
    .slice(0, 4);
  const imageUrl = await screenshotTarget({
    config,
    filename: "supercell-top.png",
    page,
    selectors: ["main", "body"],
  });

  return section({
    id: "supercell",
    status: "ok",
    imageUrl,
    items: [
      {
        title: rewardCollected ? "Reward collected" : "Reward status",
        url: sourceMeta.supercell.sourceUrl,
        subtitle: rewardMessage,
      },
      ...offers.map((offer) => ({
        title: offer.title,
        url: offer.url,
      })),
    ],
    message: rewardMessage,
  });
}

async function collectYoutubeRecommendations(
  page: Page,
): Promise<DashboardSection> {
  await goto(page, sourceMeta.youtube.sourceUrl);
  await page
    .locator("ytd-rich-item-renderer, ytd-video-renderer, a#video-title")
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);

  const rawVideos = await page.locator("a#video-title").evaluateAll((anchors) =>
    anchors.map((anchor) => {
      const element = anchor as HTMLAnchorElement;

      return {
        title:
          element.getAttribute("title")?.trim() || element.innerText?.trim(),
        url: element.href,
      };
    }),
  );
  const seen = new Set<string>();
  const items: DashboardItem[] = [];

  for (const video of rawVideos) {
    if (!video.title || !video.url || seen.has(video.url)) {
      continue;
    }

    seen.add(video.url);
    items.push({
      title: compactText(video.title, 120),
      url: video.url,
    });

    if (items.length >= 6) {
      break;
    }
  }

  return section({
    id: "youtube",
    status: items.length ? "ok" : "empty",
    items,
    message: items.length
      ? "Top visible home recommendations."
      : "No YouTube recommendations found.",
  });
}

async function collectDashboardNow() {
  const config = getConfig();

  if (activeCollection) {
    return activeCollection;
  }

  activeCollection = (async () => {
    dashboardState = {
      ...dashboardState,
      collecting: true,
      lastRunStartedAt: new Date().toISOString(),
    };
    await saveDashboardState(dashboardState, config);

    const sections: DashboardSection[] = [];
    let browser: Browser | undefined;
    const getBrowser = async () => {
      browser ??= await chromium.launch({
        headless: true,
      });

      return browser;
    };

    try {
      if (config.enabledSources.has("x")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "x", (page) =>
            collectXTimeline(page, config),
          ),
        );
      }

      if (config.enabledSources.has("instagram")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "instagram", (page) =>
            collectInstagramDmPreview(page, config),
          ),
        );
      }

      if (config.enabledSources.has("messenger")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "messenger", (page) =>
            collectMessengerPreview(page, config),
          ),
        );
      }

      if (config.enabledSources.has("facebook")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "facebook", (page) =>
            collectFacebookNotifications(page, config),
          ),
        );
      }

      if (config.enabledSources.has("anigamer")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "anigamer", (page) =>
            collectAnigamerNotifications(page),
          ),
        );
      }

      if (config.enabledSources.has("supercell")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "supercell", (page) =>
            collectSupercellReward(page, config),
          ),
        );
      }

      if (config.enabledSources.has("youtube")) {
        sections.push(
          await collectWithPage(await getBrowser(), config, "youtube", (page) =>
            collectYoutubeRecommendations(page),
          ),
        );
      }
    } finally {
      await browser?.close();
    }

    dashboardState = {
      collecting: false,
      lastRunStartedAt: dashboardState.lastRunStartedAt,
      lastRunFinishedAt: new Date().toISOString(),
      sections,
    };
    await saveDashboardState(dashboardState, config);

    return dashboardState;
  })().finally(() => {
    activeCollection = null;
  });

  return activeCollection;
}

async function claimSupercellRewardOnce() {
  const startedAt = new Date().toISOString();
  const config: AppConfig = {
    ...getConfig(),
    supercellRewardEnabled: true,
  };
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const supercellSection = await collectWithPage(
      browser,
      config,
      "supercell",
      (page) => collectSupercellReward(page, config),
    );
    dashboardState = {
      collecting: false,
      lastRunStartedAt: startedAt,
      lastRunFinishedAt: new Date().toISOString(),
      sections: [supercellSection],
    };
    await saveDashboardState(dashboardState, config);
    console.log(JSON.stringify(supercellSection, null, 2));

    return supercellSection;
  } finally {
    await browser.close();
  }
}

async function getDashboardState() {
  await loadDashboardState();

  return {
    ...dashboardState,
    collecting: Boolean(activeCollection) || dashboardState.collecting,
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
      "www-authenticate": 'Basic realm="Morning Dashboard"',
    },
  });
}

function renderItem(item: DashboardItem) {
  const subtitle = [item.subtitle, item.timestamp]
    .filter(Boolean)
    .map((value) => `<span>${escapeHtml(value ?? "")}</span>`)
    .join("");
  const summary = item.summary
    ? `<p class="item-summary">${escapeHtml(compactText(item.summary, 220))}</p>`
    : "";

  return `<li class="item">
    <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>
    ${subtitle ? `<div class="item-meta">${subtitle}</div>` : ""}
    ${summary}
  </li>`;
}

function renderSection(currentSection: DashboardSection) {
  const message = currentSection.message
    ? `<p class="section-message">${escapeHtml(currentSection.message)}</p>`
    : "";
  const image = currentSection.imageUrl
    ? `<a class="preview" href="${escapeHtml(currentSection.sourceUrl)}"><img src="${escapeHtml(currentSection.imageUrl)}?t=${encodeURIComponent(currentSection.collectedAt)}" alt="${escapeHtml(currentSection.title)} preview" loading="lazy"></a>`
    : "";
  const items = currentSection.items.length
    ? `<ul class="items">${currentSection.items.map(renderItem).join("")}</ul>`
    : '<p class="empty">No items.</p>';

  return `<section class="section-card">
    <div class="section-header">
      <div>
        <h2>${escapeHtml(currentSection.title)}</h2>
        <a class="source-link" href="${escapeHtml(currentSection.sourceUrl)}">Open source</a>
      </div>
      <span class="status ${currentSection.status}">${currentSection.status}</span>
    </div>
    ${message}
    ${image}
    ${items}
  </section>`;
}

function renderDashboard(current: DashboardState, config: AppConfig) {
  const sections = current.sections.length
    ? current.sections.map(renderSection).join("")
    : '<p class="empty">No digest collected yet.</p>';

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
      --color-surface-raised: #20242a;
      --color-border: #343842;
      --color-text: #edf4ef;
      --color-muted: #a5abb7;
      --color-accent: #8ab4ff;
      --color-success: #80d39b;
      --color-warning: #f0c36a;
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
      font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: var(--space-6);
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: end;
      margin-bottom: var(--space-6);
    }
    h1, h2, p, ul { margin: 0; }
    h1 { font-size: 28px; line-height: 1.2; }
    h2 { font-size: 18px; line-height: 1.25; }
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
    .subtle, .empty, .section-message, .source-link {
      color: var(--color-muted);
    }
    .subtle { margin-top: var(--space-2); }
    .actions {
      display: flex;
      gap: var(--space-2);
      align-items: center;
    }
    .sections {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: var(--space-4);
      align-items: start;
    }
    .section-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      overflow: hidden;
    }
    .section-header {
      min-height: 72px;
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      padding: var(--space-4);
      border-bottom: 1px solid var(--color-border);
    }
    .section-message {
      padding: var(--space-3) var(--space-4) 0;
    }
    .status {
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
    .status.config, .status.empty { color: var(--color-warning); }
    .status.error { color: var(--color-error); }
    .preview {
      display: block;
      aspect-ratio: 16 / 9;
      margin: var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-bg);
      overflow: hidden;
    }
    img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      object-position: top center;
    }
    .items {
      list-style: none;
      display: grid;
      gap: var(--space-2);
      padding: var(--space-4);
    }
    .item {
      padding: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface-raised);
    }
    .item > a {
      display: block;
      color: var(--color-text);
      text-decoration: none;
    }
    .item > a:hover { color: var(--color-accent); }
    .item-meta {
      display: flex;
      gap: var(--space-2);
      flex-wrap: wrap;
      margin-top: var(--space-1);
      color: var(--color-muted);
      font-size: 13px;
    }
    .item-summary {
      margin-top: var(--space-2);
      color: var(--color-muted);
    }
    .empty { padding: var(--space-4); }
    @media (max-width: 760px) {
      main { padding: var(--space-4); }
      header, .section-header { display: block; }
      .actions { margin-top: var(--space-4); }
      .sections { grid-template-columns: 1fr; }
      .status { margin-top: var(--space-2); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Morning Dashboard</h1>
        <p class="subtle">${current.collecting ? "Collection running" : "Last updated"}${current.lastRunFinishedAt ? ` ${escapeHtml(new Date(current.lastRunFinishedAt).toLocaleString())}` : ""}</p>
      </div>
      <div class="actions">
        <a href="${config.publicBasePath}/api/dashboard">JSON</a>
        <form method="post" action="${config.publicBasePath}/api/refresh"><button type="submit">Refresh</button></form>
      </div>
    </header>
    <div class="sections">${sections}</div>
  </main>
</body>
</html>`;
}

async function handleRequest(request: Request) {
  const config = getConfig();
  const url = new URL(request.url);
  const pathname =
    config.publicBasePath && url.pathname.startsWith(`${config.publicBasePath}/`)
      ? url.pathname.slice(config.publicBasePath.length)
      : url.pathname === config.publicBasePath
        ? "/"
        : url.pathname;

  if (request.method === "GET" && pathname === "/api/health") {
    return jsonResponse({ ok: true });
  }

  if (!isAccessAuthorized(request, config)) {
    return unauthorizedResponse();
  }

  if (
    request.method === "GET" &&
    (pathname === "/api/dashboard" || pathname === "/api/screenshots")
  ) {
    return jsonResponse(await getDashboardState());
  }

  if (request.method === "POST" && pathname === "/api/refresh") {
    if (!isRefreshAuthorized(request, config)) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
    }

    const nextState = await collectDashboardNow();
    const accept = request.headers.get("accept") || "";

    if (accept.includes("text/html")) {
      return Response.redirect(new URL(config.publicBasePath || "/", request.url), 303);
    }

    return jsonResponse({ ok: true, dashboard: nextState });
  }

  if (request.method === "GET" && pathname.startsWith("/assets/")) {
    const filename = pathname.slice("/assets/".length);
    const file = Bun.file(assetPath(config, filename));

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

  if (request.method === "GET" && pathname === "/") {
    return new Response(renderDashboard(await getDashboardState(), config), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response("Not found", { status: 404 });
}

async function startScheduler() {
  const config = getConfig();

  await loadDashboardState(config);

  if (!config.collectEnabled) {
    return;
  }

  void collectDashboardNow().catch((error) => {
    console.error("Dashboard collection failed:", error);
  });

  setInterval(() => {
    void collectDashboardNow().catch((error) => {
      console.error("Dashboard collection failed:", error);
    });
  }, config.intervalMs);

  console.log(
    `Dashboard collection enabled every ${Math.round(
      config.intervalMs / 60_000,
    )} minutes.`,
  );
}

if (process.argv.includes("--capture-once")) {
  await collectDashboardNow();
  process.exit(0);
}

if (process.argv.includes(CLAIM_SUPERCELL_REWARD_FLAG)) {
  const supercellSection = await claimSupercellRewardOnce();
  process.exit(supercellSection.status === "error" ? 1 : 0);
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
