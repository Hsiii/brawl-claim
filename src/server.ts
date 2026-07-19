import { timingSafeEqual } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright";
import { chromium } from "playwright";

import {
  handleDiscordInteraction,
  notifyLinkedDiscordUsers,
} from "./discord";

const APP_NAME = "BrawlClaim";
const STORE_URL = "https://store.supercell.com/brawlstars";
const DEFAULT_PORT = 3100;
const DEFAULT_DATA_DIR = ".data/brawl-claim";
const DEFAULT_INTERVAL_MINUTES = 24 * 60;
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const STORE_READY_TIMEOUT_MS = 30_000;
const STORE_STABILITY_MS = 2_000;
const STORE_NAVIGATION_ATTEMPTS = 2;
const SCREENSHOT_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const CLAIM_VERIFICATION_TIMEOUT_MS = 20_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 180_000;
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 1000;
const STATE_FILE = "claim.json";
const LOCK_FILE = "claim.lock";
const DEFAULT_PROFILE_ID = "me";
const CLAIM_FLAGS = new Set(["--claim-once"]);
const IS_CLAIM_ONCE = process.argv.some((argument) => CLAIM_FLAGS.has(argument));
const CSRF_TOKEN = crypto.randomUUID();

type ClaimStatus =
  | "claimed"
  | "claim_unconfirmed"
  | "no_reward"
  | "login_required"
  | "error";

type ClaimVerification = "confirmed" | "unconfirmed" | "not_attempted";

type ClaimOffer = {
  title: string;
  url: string;
};

type ClaimProfile = {
  authStateFile?: string;
  id: string;
  label: string;
  screenshotFilename: string;
};

type ClaimResult = {
  status: ClaimStatus;
  claimed: boolean;
  attempted: boolean;
  loggedIn: boolean;
  message: string;
  checkedAt: string;
  sourceUrl: string;
  profileId: string;
  profileLabel: string;
  imageUrl?: string;
  offers: ClaimOffer[];
  verification: ClaimVerification;
  verificationEvidence: string[];
};

type ProfileClaimState = {
  id: string;
  label: string;
  claiming: boolean;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  result?: ClaimResult;
};

type ClaimState = {
  claiming: boolean;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  profiles: Record<string, ProfileClaimState>;
};

type AppConfig = {
  accessPassword?: string;
  accessUsername?: string;
  allowInsecureAccess: boolean;
  claimEnabled: boolean;
  claimTimeoutMs: number;
  dataDir: string;
  discordBotToken?: string;
  discordPublicKey?: string;
  intervalMs: number;
  profiles: ClaimProfile[];
  publicBasePath: string;
  refreshToken?: string;
  rewardSelectors: string[];
};

type RawClaimState = Partial<ClaimState> & {
  result?: Partial<ClaimResult>;
};

let claimState: ClaimState = {
  claiming: false,
  profiles: {},
};
let activeClaim: Promise<ClaimState> | null = null;
let cachedConfig: AppConfig | undefined;

class ClaimInProgressError extends Error {
  constructor() {
    super("Another BrawlClaim process is already running a claim.");
    this.name = "ClaimInProgressError";
  }
}

function readEnv(name: string) {
  return process.env[name]?.trim() || undefined;
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

function normalizeProfileId(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || DEFAULT_PROFILE_ID
  );
}

function profileDisplayName(id: string) {
  if (id === DEFAULT_PROFILE_ID) {
    return "Me";
  }

  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`)
    .join(" ");
}

function profileEnvKey(profileId: string, suffix: string) {
  const envId = profileId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

  return `BRAWL_STARS_CLAIMER_${envId}_${suffix}`;
}

function parseProfileEntry(entry: string, index: number) {
  const [rawId, ...labelParts] = entry.split(":");
  const id = normalizeProfileId(rawId || `profile-${index + 1}`);
  const label = labelParts.join(":").trim() || profileDisplayName(id);

  return {
    id,
    label,
  };
}

function parseProfiles(dataDir: string, firstAuthStateFile?: string) {
  const rawProfiles =
    readEnv("BRAWL_STARS_CLAIMER_PROFILES") || DEFAULT_PROFILE_ID;
  const seenIds = new Set<string>();
  const parsedProfiles = rawProfiles
    .split(",")
    .map((entry, index) => parseProfileEntry(entry, index))
    .filter((profile) => {
      if (seenIds.has(profile.id)) {
        return false;
      }

      seenIds.add(profile.id);
      return true;
    });
  const profiles =
    parsedProfiles.length > 0
      ? parsedProfiles
      : [{ id: DEFAULT_PROFILE_ID, label: "Me" }];

  return profiles.map((profile, index): ClaimProfile => {
    const authStateFile =
      readEnv(profileEnvKey(profile.id, "AUTH_STATE_FILE")) ||
      (index === 0 ? firstAuthStateFile : undefined) ||
      join(dataDir, "profiles", profile.id, "auth.json");

    return {
      ...profile,
      authStateFile,
      screenshotFilename:
        profile.id === DEFAULT_PROFILE_ID
          ? "brawl-stars-store.png"
          : `brawl-stars-store-${profile.id}.png`,
    };
  });
}

function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const dataDir = readEnv("BRAWL_STARS_CLAIMER_DATA_DIR") || DEFAULT_DATA_DIR;
  const authStateFile = readEnv("BRAWL_STARS_CLAIMER_AUTH_STATE_FILE");
  const accessPassword = readEnv("BRAWL_STARS_CLAIMER_ACCESS_PASSWORD");
  const accessUsername = readEnv("BRAWL_STARS_CLAIMER_ACCESS_USERNAME");
  const discordBotToken = readEnv("BRAWL_CLAIM_DISCORD_BOT_TOKEN");
  const discordPublicKey = readEnv("BRAWL_CLAIM_DISCORD_PUBLIC_KEY");

  if (Boolean(accessPassword) !== Boolean(accessUsername)) {
    throw new Error(
      "BRAWL_STARS_CLAIMER_ACCESS_USERNAME and BRAWL_STARS_CLAIMER_ACCESS_PASSWORD must be configured together.",
    );
  }

  if (Boolean(discordBotToken) !== Boolean(discordPublicKey)) {
    throw new Error(
      "BRAWL_CLAIM_DISCORD_BOT_TOKEN and BRAWL_CLAIM_DISCORD_PUBLIC_KEY must be configured together.",
    );
  }

  cachedConfig = {
    accessPassword,
    accessUsername,
    allowInsecureAccess: parseBoolean(
      readEnv("BRAWL_STARS_CLAIMER_ALLOW_INSECURE_ACCESS"),
      false,
    ),
    claimEnabled: parseBoolean(
      readEnv("BRAWL_CLAIM_ENABLED"),
      false,
    ),
    claimTimeoutMs:
      Number(readEnv("BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS")) ||
      DEFAULT_CLAIM_TIMEOUT_MS,
    dataDir,
    discordBotToken,
    discordPublicKey,
    intervalMs:
      Number(readEnv("BRAWL_STARS_CLAIMER_INTERVAL_MINUTES")) *
        60 *
        1000 || DEFAULT_INTERVAL_MINUTES * 60 * 1000,
    profiles: parseProfiles(dataDir, authStateFile),
    publicBasePath: normalizeBasePath(
      readEnv("BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH"),
    ),
    refreshToken: readEnv("BRAWL_STARS_CLAIMER_REFRESH_TOKEN"),
    rewardSelectors: (
      readEnv("BRAWL_STARS_CLAIMER_REWARD_SELECTORS") ||
      'button:has-text("Claim"),button:has-text("Collect"),[role="button"]:has-text("Claim"),[role="button"]:has-text("Collect")'
    )
      .split(",")
      .map((selector) => selector.trim())
      .filter(Boolean),
  };
  return cachedConfig;
}

function statePath(config = getConfig()) {
  return join(config.dataDir, STATE_FILE);
}

function lockPath(config = getConfig()) {
  return join(config.dataDir, LOCK_FILE);
}

function assetPath(config: AppConfig, filename: string) {
  return join(config.dataDir, filename);
}

function assetUrl(config: AppConfig, filename: string) {
  return `${config.publicBasePath}/assets/${encodeURIComponent(filename)}`;
}

async function fileExists(path: string | undefined) {
  if (!path) {
    return false;
  }

  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

function normalizeResult(
  result: Partial<ClaimResult> | undefined,
  profile: ClaimProfile,
) {
  if (!result?.status || !result.checkedAt || !result.sourceUrl) {
    return undefined;
  }

  return {
    status: result.status,
    claimed: Boolean(result.claimed),
    attempted: Boolean(result.attempted ?? result.claimed),
    loggedIn: Boolean(result.loggedIn),
    message: result.message || "",
    checkedAt: result.checkedAt,
    sourceUrl: result.sourceUrl,
    profileId: profile.id,
    profileLabel: profile.label,
    imageUrl: result.imageUrl,
    offers: Array.isArray(result.offers) ? result.offers : [],
    verification:
      result.verification === "confirmed" ||
      result.verification === "unconfirmed" ||
      result.verification === "not_attempted"
        ? result.verification
        : result.claimed
          ? "confirmed"
          : "not_attempted",
    verificationEvidence: Array.isArray(result.verificationEvidence)
      ? result.verificationEvidence
      : [],
  } satisfies ClaimResult;
}

function normalizeClaimState(
  rawState: RawClaimState | undefined,
  config: AppConfig,
): ClaimState {
  const rawProfiles =
    rawState?.profiles && typeof rawState.profiles === "object"
      ? rawState.profiles
      : {};
  const nextState: ClaimState = {
    claiming: Boolean(rawState?.claiming),
    lastRunStartedAt: rawState?.lastRunStartedAt,
    lastRunFinishedAt: rawState?.lastRunFinishedAt,
    profiles: {},
  };

  config.profiles.forEach((profile, index) => {
    const existing =
      rawProfiles[profile.id] ||
      (index === 0 && rawState?.result
        ? {
            claiming: rawState.claiming,
            lastRunStartedAt: rawState.lastRunStartedAt,
            lastRunFinishedAt: rawState.lastRunFinishedAt,
            result: rawState.result,
          }
        : undefined);

    nextState.profiles[profile.id] = {
      id: profile.id,
      label: profile.label,
      claiming: Boolean(existing?.claiming),
      lastRunStartedAt: existing?.lastRunStartedAt,
      lastRunFinishedAt: existing?.lastRunFinishedAt,
      result: normalizeResult(existing?.result, profile),
    };
  });

  nextState.claiming =
    nextState.claiming ||
    Object.values(nextState.profiles).some((profile) => profile.claiming);

  return nextState;
}

async function loadClaimState(config = getConfig()) {
  try {
    const rawState = JSON.parse(
      await readFile(statePath(config), "utf8"),
    ) as RawClaimState;
    claimState = normalizeClaimState(rawState, config);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      claimState = normalizeClaimState(claimState, config);
      return claimState;
    }

    console.warn("Failed to read claim state:", error);
    claimState = normalizeClaimState(claimState, config);
  }

  return claimState;
}

async function saveClaimState(nextState: ClaimState, config = getConfig()) {
  const path = statePath(config);
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(temporaryPath, JSON.stringify(nextState, null, 2), {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    });
  }
}

function claimLockMaxAge(config: AppConfig) {
  return config.claimTimeoutMs * Math.max(config.profiles.length, 1) + 60_000;
}

async function isClaimLockActive(config = getConfig()) {
  try {
    const lockStat = await stat(lockPath(config));

    return Date.now() - lockStat.mtimeMs <= claimLockMaxAge(config);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }

    throw error;
  }
}

async function acquireClaimLock(config = getConfig()) {
  const path = lockPath(config);

  await mkdir(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      let released = false;

      try {
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }

      return async () => {
        if (released) {
          return;
        }

        released = true;
        await handle.close().catch(() => undefined);
        await unlink(path).catch((error) => {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            (error as { code?: string }).code !== "ENOENT"
          ) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as { code?: string }).code !== "EEXIST"
      ) {
        throw error;
      }

      if (await isClaimLockActive(config)) {
        throw new ClaimInProgressError();
      }

      await unlink(path).catch(() => undefined);
    }
  }

  throw new ClaimInProgressError();
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
  let lastError: unknown;

  for (let attempt = 1; attempt <= STORE_NAVIGATION_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(STORE_URL, {
        waitUntil: "commit",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await page.waitForFunction(
        () => {
          const body = document.body;
          const text = body?.innerText.replace(/\s+/g, " ").trim() || "";
          const waitingRoom = /checking your browser|just a moment/i.test(text);

          return Boolean(
            body &&
              text.length >= 40 &&
              !waitingRoom &&
              (document.readyState !== "loading" ||
                body.querySelector("button,[role='button'],a[href*='/product/']")),
          );
        },
        undefined,
        { timeout: STORE_READY_TIMEOUT_MS },
      );
      await page.waitForTimeout(STORE_STABILITY_MS);
      return;
    } catch (error) {
      lastError = error;

      if (attempt < STORE_NAVIGATION_ATTEMPTS) {
        await page.waitForTimeout(1_000 * 2 ** (attempt - 1));
      }
    }
  }

  const detail =
    lastError instanceof Error ? ` ${lastError.message}` : "";

  throw new Error(
    `Supercell Store did not become ready after ${STORE_NAVIGATION_ATTEMPTS} attempts.${detail}`,
    { cause: lastError },
  );
}

async function screenshotTarget({
  config,
  filename,
  page,
}: {
  config: AppConfig;
  filename: string;
  page: Page;
}) {
  await mkdir(config.dataDir, { recursive: true });
  const path = assetPath(config, filename);

  try {
    await page.screenshot({
      path,
      fullPage: false,
      timeout: SCREENSHOT_TIMEOUT_MS,
    });

    return assetUrl(config, filename);
  } catch {
    return undefined;
  }
}

function normalizeStoreText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

async function frameBodyText(frame: Frame) {
  return frame
    .locator("body")
    .innerText({ timeout: ACTION_TIMEOUT_MS })
    .then(normalizeStoreText)
    .catch(() => "");
}

async function storeBodyText(page: Page) {
  return normalizeStoreText(
    (await Promise.all(page.frames().map(frameBodyText))).filter(Boolean).join(" "),
  );
}

async function collectOffers(page: Page) {
  const offers = await Promise.all(
    page.frames().map((frame) =>
      frame
        .locator("a[href*='/product/']")
        .evaluateAll((anchors) =>
          anchors.map((element) => {
            const anchor = element as HTMLAnchorElement;

            return {
              title: (
                anchor.innerText ||
                anchor.getAttribute("aria-label") ||
                anchor.title
              )
                .replace(/\s+/g, " ")
                .trim(),
              url: anchor.href,
            };
          }),
        )
        .catch(() => []),
    ),
  );

  return offers.flat();
}

async function findRewardControl(page: Page, selectors: string[]) {
  const invalidSelectors: string[] = [];
  let validSelectorCount = 0;

  for (const selector of selectors) {
    for (const frame of page.frames()) {
      try {
        const matches = frame.locator(selector);
        const matchIndex = await matches.evaluateAll((elements) =>
          elements.slice(0, 20).findIndex((element) => {
            const control = element as HTMLButtonElement;
            const style = getComputedStyle(element);

            return Boolean(
              element.getClientRects().length > 0 &&
                style.visibility !== "hidden" &&
                !control.disabled &&
                element.getAttribute("aria-disabled") !== "true",
            );
          }),
        );
        validSelectorCount += 1;

        if (matchIndex >= 0) {
          return { locator: matches.nth(matchIndex), selector };
        }
      } catch {
        invalidSelectors.push(selector);
        break;
      }
    }
  }

  if (validSelectorCount === 0 && invalidSelectors.length > 0) {
    throw new Error(
      `Every reward selector is invalid: ${[...new Set(invalidSelectors)].join(", ")}`,
    );
  }

  return undefined;
}

async function hasLoginPrompt(page: Page, bodyText: string) {
  if (/log in to view offers/i.test(bodyText)) {
    return true;
  }

  for (const frame of page.frames()) {
    const labels = await frame
      .locator("button,[role='button'],a")
      .evaluateAll((elements) =>
        elements.slice(0, 100).flatMap((element) => {
          const style = getComputedStyle(element);

          if (
            element.getClientRects().length === 0 ||
            style.visibility === "hidden"
          ) {
            return [];
          }

          return [
            (
              (element as HTMLElement).innerText ||
              element.getAttribute("aria-label") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          ];
        }),
      )
      .catch(() => []);

    if (labels.some((label) => /^(?:log|sign) in$/i.test(label))) {
      return true;
    }
  }

  return false;
}

function confirmationTextEvidence(before: string, after: string) {
  const patterns = [
    /reward (?:has been )?(?:claimed|collected)/i,
    /(?:claimed|collected) successfully/i,
    /successfully (?:claimed|collected)/i,
    /(?:reward|item) (?:was )?added to your (?:account|game)/i,
  ];

  return patterns
    .filter((pattern) => pattern.test(after) && !pattern.test(before))
    .map((pattern) => `Store confirmation matched ${pattern.source}`);
}

function claimMutationEvidence(
  method: string,
  responseUrl: string,
  status: number,
) {
  const url = new URL(responseUrl);
  const claimEndpoint =
    /(?:^|[-_/.])(?:claim|collect|redeem|reward|purchase|order)(?:[-_/.]|$)/i;

  if (
    method === "GET" ||
    status < 200 ||
    status >= 300 ||
    !claimEndpoint.test(url.pathname)
  ) {
    return undefined;
  }

  return `${method} ${url.origin}${url.pathname} returned ${status}`;
}

async function verifyClaimClick({
  beforeText,
  locator,
  mutationEvidence,
  page,
}: {
  beforeText: string;
  locator: Locator;
  mutationEvidence: string[];
  page: Page;
}) {
  const deadline = Date.now() + CLAIM_VERIFICATION_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const textEvidence = confirmationTextEvidence(
      beforeText,
      await storeBodyText(page),
    );
    const evidence = [...new Set([...textEvidence, ...mutationEvidence])];

    if (evidence.length > 0) {
      return { confirmed: true, evidence };
    }

    await page.waitForTimeout(500);
  }

  const controlChanged = await locator
    .evaluate((element) => {
      const control = element as HTMLButtonElement;

      return !element.isConnected || control.disabled || element.getClientRects().length === 0;
    })
    .catch(() => true);

  return {
    confirmed: false,
    evidence: controlChanged
      ? ["Reward control changed after the click, but no confirmation was observed."]
      : ["Reward control was clicked, but the Store did not confirm the claim."],
  };
}

async function claimWithPage({
  config,
  hasAuthState,
  page,
  profile,
}: {
  config: AppConfig;
  hasAuthState: boolean;
  page: Page;
  profile: ClaimProfile;
}): Promise<ClaimResult> {
  await gotoStore(page);
  const beforeText = await storeBodyText(page);
  const loggedOut = await hasLoginPrompt(page, beforeText);
  const storeError = beforeText.match(
    /(?:something went wrong|access denied|checking your browser|service unavailable)/i,
  )?.[0];

  if (storeError) {
    throw new Error(`Supercell Store returned an unusable page: ${storeError}`);
  }

  const rewardControl = loggedOut
    ? undefined
    : await findRewardControl(page, config.rewardSelectors);
  const loggedIn = Boolean(rewardControl) || !loggedOut;
  let claimed = false;
  let attempted = false;
  let verification: ClaimVerification = "not_attempted";
  let verificationEvidence: string[] = [];
  let status: ClaimStatus = loggedIn ? "no_reward" : "login_required";
  let message = loggedIn
    ? `No visible reward button found for ${profile.label}.`
    : `Supercell Store is logged out for ${profile.label}. Refresh the saved auth state.`;

  if (!hasAuthState && !loggedIn) {
    message = `No saved auth state for ${profile.label}. Run auth setup for this profile.`;
  }

  if (rewardControl) {
    attempted = true;
    const mutationEvidence: string[] = [];
    const onResponse = (response: import("playwright").Response) => {
      const evidence = claimMutationEvidence(
        response.request().method(),
        response.url(),
        response.status(),
      );

      if (evidence) {
        mutationEvidence.push(evidence);
      }
    };

    page.on("response", onResponse);

    try {
      await rewardControl.locator.click({ timeout: ACTION_TIMEOUT_MS });
      const result = await verifyClaimClick({
        beforeText,
        locator: rewardControl.locator,
        mutationEvidence,
        page,
      });

      claimed = result.confirmed;
      verification = result.confirmed ? "confirmed" : "unconfirmed";
      verificationEvidence = result.evidence;
      status = result.confirmed ? "claimed" : "claim_unconfirmed";
      message = result.confirmed
        ? `Reward claim was verified for ${profile.label}.`
        : `Reward control was clicked for ${profile.label}, but the Store did not confirm success.`;
    } finally {
      page.off("response", onResponse);
    }
  }

  const seenOfferUrls = new Set<string>();
  const offers = (await collectOffers(page))
    .filter((offer) => {
      if (!offer.title || !offer.url || seenOfferUrls.has(offer.url)) {
        return false;
      }

      seenOfferUrls.add(offer.url);
      return true;
    })
    .slice(0, 4)
    .map((offer) => ({
      title: compactText(offer.title),
      url: offer.url,
    }));
  const imageUrl = await screenshotTarget({
    config,
    filename: profile.screenshotFilename,
    page,
  });

  return {
    status,
    claimed,
    attempted,
    loggedIn,
    message,
    checkedAt: new Date().toISOString(),
    sourceUrl: STORE_URL,
    profileId: profile.id,
    profileLabel: profile.label,
    imageUrl,
    offers,
    verification,
    verificationEvidence,
  };
}

function errorResult(error: unknown, profile: ClaimProfile): ClaimResult {
  return {
    status: "error",
    claimed: false,
    attempted: false,
    loggedIn: false,
    message: error instanceof Error ? error.message : "Unknown error",
    checkedAt: new Date().toISOString(),
    sourceUrl: STORE_URL,
    profileId: profile.id,
    profileLabel: profile.label,
    offers: [],
    verification: "not_attempted",
    verificationEvidence: [],
  };
}

async function claimBrawlStarsReward(
  profile: ClaimProfile,
  config = getConfig(),
) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    return await withTimeout(
      (async () => {
        browser = await chromium.launch({
          headless: !process.env.DISPLAY,
        });
        const hasAuthState = await fileExists(profile.authStateFile);
        const contextOptions: Parameters<typeof browser.newContext>[0] = {
          viewport: {
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT,
          },
        };

        if (hasAuthState && profile.authStateFile) {
          contextOptions.storageState = profile.authStateFile;
        }

        context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

        return claimWithPage({
          config,
          hasAuthState,
          page,
          profile,
        });
      })(),
      config.claimTimeoutMs,
      `${APP_NAME} ${profile.label}`,
    );
  } catch (error) {
    return errorResult(error, profile);
  } finally {
    if (context) {
      await withTimeout(
        context.close(),
        CLEANUP_TIMEOUT_MS,
        "Browser context cleanup",
      ).catch(() => undefined);
    }

    if (browser) {
      await withTimeout(
        browser.close(),
        CLEANUP_TIMEOUT_MS,
        "Browser cleanup",
      ).catch(() => undefined);
    }
  }
}

function findProfile(config: AppConfig, profileId: string | undefined | null) {
  if (!profileId) {
    return undefined;
  }

  const normalizedId = normalizeProfileId(profileId);

  return config.profiles.find((profile) => profile.id === normalizedId);
}

async function runClaimNow(profileId?: string) {
  const config = getConfig();
  const selectedProfile = findProfile(config, profileId);

  if (profileId && !selectedProfile) {
    throw new Error(`Unknown BrawlClaim profile: ${profileId}`);
  }

  if (activeClaim) {
    return activeClaim;
  }

  activeClaim = (async () => {
    const releaseLock = await acquireClaimLock(config);

    try {
      await loadClaimState(config);

      const targetProfiles = selectedProfile
        ? [selectedProfile]
        : config.profiles;
      const startedAt = new Date().toISOString();
      claimState = normalizeClaimState(
        {
          ...claimState,
          claiming: true,
          lastRunStartedAt: startedAt,
        },
        config,
      );

      for (const profile of targetProfiles) {
        claimState.profiles[profile.id] = {
          ...claimState.profiles[profile.id],
          id: profile.id,
          label: profile.label,
          claiming: true,
          lastRunStartedAt: startedAt,
        };
      }

      await saveClaimState(claimState, config);

      for (const profile of targetProfiles) {
        const result = await claimBrawlStarsReward(profile, config);
        claimState.profiles[profile.id] = {
          ...claimState.profiles[profile.id],
          id: profile.id,
          label: profile.label,
          claiming: false,
          lastRunStartedAt: startedAt,
          lastRunFinishedAt: new Date().toISOString(),
          result,
        };
        await saveClaimState(claimState, config);
      }

      claimState = {
        ...claimState,
        claiming: false,
        lastRunStartedAt: startedAt,
        lastRunFinishedAt: new Date().toISOString(),
      };
      await saveClaimState(claimState, config);

      await notifyLinkedDiscordUsers({
        botToken: config.discordBotToken,
        dataDir: config.dataDir,
        results: targetProfiles.flatMap((profile) => {
          const result = claimState.profiles[profile.id]?.result;

          return result ? [{ profile, result }] : [];
        }),
      });

      return claimState;
    } finally {
      await releaseLock();
    }
  })().finally(() => {
    activeClaim = null;
  });

  return activeClaim;
}

async function getClaimState() {
  const config = getConfig();

  await loadClaimState(config);
  const claiming = Boolean(activeClaim) || (await isClaimLockActive(config));

  return {
    ...claimState,
    claiming,
    profiles: Object.fromEntries(
      Object.entries(claimState.profiles).map(([id, profile]) => [
        id,
        {
          ...profile,
          claiming: claiming && profile.claiming,
        },
      ]),
    ),
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

function secureEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isRefreshAuthorized(request: Request, config: AppConfig) {
  if (!config.refreshToken) {
    return false;
  }

  const authorization = request.headers.get("authorization");

  return Boolean(
    authorization?.startsWith("Bearer ") &&
      secureEqual(authorization.slice("Bearer ".length), config.refreshToken),
  );
}

function getBasicAuthCredentials(request: Request) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Basic ")) {
    return null;
  }

  let decoded: string;

  try {
    decoded = atob(authorization.slice("Basic ".length));
  } catch {
    return null;
  }
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
    return config.allowInsecureAccess;
  }

  const credentials = getBasicAuthCredentials(request);

  return Boolean(
    credentials &&
      secureEqual(credentials.username, config.accessUsername) &&
      secureEqual(credentials.password, config.accessPassword)
  );
}

async function isCsrfAuthorized(request: Request) {
  const contentType = request.headers.get("content-type") || "";

  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return false;
  }

  const form = await request.formData();
  const csrfToken = form.get("csrfToken");

  return typeof csrfToken === "string" && secureEqual(csrfToken, CSRF_TOKEN);
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

function renderCheckedAt(result: ClaimResult | undefined) {
  return result?.checkedAt
    ? new Date(result.checkedAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "Asia/Taipei",
      })
    : "Never";
}

function renderVerification(result: ClaimResult | undefined) {
  if (!result?.attempted) {
    return "Not attempted";
  }

  const evidence = result.verificationEvidence[0];
  const label = result.verification === "confirmed" ? "Confirmed" : "Unconfirmed";

  return evidence ? `${label}: ${evidence}` : label;
}

function renderProfileCard(profileState: ProfileClaimState, config: AppConfig) {
  const result = profileState.result;
  const image = result?.imageUrl
    ? `<a class="preview" href="${escapeHtml(STORE_URL)}"><img src="${escapeHtml(result.imageUrl)}?t=${encodeURIComponent(result.checkedAt)}" alt="${escapeHtml(profileState.label)} Brawl Stars Store preview" loading="lazy"></a>`
    : '<div class="preview empty-preview">No screenshot yet</div>';

  return `<article class="profile-card">
    <div class="profile-header">
      <div>
        <h2>${escapeHtml(profileState.label)}</h2>
        <p class="meta">Last checked: ${escapeHtml(renderCheckedAt(result))}</p>
      </div>
      <form method="post" action="${config.publicBasePath}/api/claim?profile=${encodeURIComponent(profileState.id)}">
        <input type="hidden" name="csrfToken" value="${CSRF_TOKEN}">
        <button type="submit">${profileState.claiming ? "Claiming..." : "Claim"}</button>
      </form>
    </div>
    <div class="profile-content">
      ${image}
      <div class="details">
        ${renderStatusBadge(result)}
        <p class="message">${escapeHtml(result?.message || "No claim has run yet.")}</p>
        <p class="meta">Verification: ${escapeHtml(renderVerification(result))}</p>
        <div>
          <h3>Captured Offers</h3>
          ${renderOffers(result?.offers || [])}
        </div>
        <p class="meta">Logged in: ${result ? (result.loggedIn ? "yes" : "no") : "unknown"}</p>
      </div>
    </div>
  </article>`;
}

function renderPage(state: ClaimState, config: AppConfig) {
  const profileCards = config.profiles
    .map((profile) => state.profiles[profile.id])
    .filter((profile): profile is ProfileClaimState => Boolean(profile))
    .map((profile) => renderProfileCard(profile, config))
    .join("");
  const checkedAt = state.lastRunFinishedAt
    ? new Date(state.lastRunFinishedAt).toLocaleString("en-US", {
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
      width: min(1120px, 100%);
      margin: 0 auto;
      padding: var(--space-8);
    }
    header, .summary, .profile-header {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: end;
    }
    header, .summary { margin-bottom: var(--space-6); }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.2; }
    h2 { font-size: 20px; line-height: 1.25; }
    h3 { font-size: 16px; line-height: 1.25; }
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
    .profiles {
      display: grid;
      gap: var(--space-4);
    }
    .profile-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      overflow: hidden;
    }
    .profile-header {
      padding: var(--space-4);
      border-bottom: 1px solid var(--color-border);
    }
    .profile-content {
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
    .badge[data-status="no_reward"],
    .badge[data-status="claim_unconfirmed"] { color: var(--color-warning); }
    .badge[data-status="error"] { color: var(--color-error); }
    .offers {
      margin: 0;
      padding-left: var(--space-6);
    }
    @media (max-width: 760px) {
      main { padding: var(--space-4); }
      header, .summary, .profile-header {
        display: grid;
        align-items: start;
      }
      .profile-content { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${APP_NAME}</h1>
        <p class="subtle">Daily Supercell Store reward claims for ${config.profiles.length} ${config.profiles.length === 1 ? "profile" : "profiles"}.</p>
      </div>
      <a href="${STORE_URL}">Open store</a>
    </header>
    <section class="summary">
      <div>
        <h2>Claim Status</h2>
        <p class="meta">Last full run: ${escapeHtml(checkedAt)}</p>
      </div>
      <form method="post" action="${config.publicBasePath}/api/claim">
        <input type="hidden" name="csrfToken" value="${CSRF_TOKEN}">
        <button type="submit">${state.claiming ? "Claiming..." : "Claim all"}</button>
      </form>
    </section>
    <section class="profiles">${profileCards}</section>
  </main>
</body>
</html>`;
}

function stripBasePath(pathname: string, basePath: string) {
  if (!basePath) {
    return pathname;
  }

  if (pathname === basePath) {
    return "/";
  }

  if (!pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }

  return pathname.slice(basePath.length) || "/";
}

function htmlHeaders() {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

async function handleRequest(request: Request) {
  const config = getConfig();
  const url = new URL(request.url);
  const pathname = stripBasePath(url.pathname, config.publicBasePath);

  if (!pathname) {
    return new Response("Not found", { status: 404 });
  }

  if (
    request.method === "POST" &&
    pathname === "/api/discord/interactions"
  ) {
    return handleDiscordInteraction(request, {
      dataDir: config.dataDir,
      getResult: async (profileId) =>
        (await getClaimState()).profiles[profileId]?.result,
      profiles: config.profiles,
      publicKey: config.discordPublicKey,
    });
  }

  if (pathname === "/api/health") {
    return jsonResponse({
      ok: true,
      claiming: Boolean(activeClaim) || (await isClaimLockActive(config)),
      profileCount: config.profiles.length,
    });
  }

  if (
    request.method === "POST" &&
    (pathname === "/api/claim" || pathname === "/api/refresh")
  ) {
    const bearerAuthorized = isRefreshAuthorized(request, config);

    if (!bearerAuthorized) {
      if (!isAccessAuthorized(request, config)) {
        return unauthorizedResponse();
      }

      if (!(await isCsrfAuthorized(request))) {
        return jsonResponse({ ok: false, error: "Invalid CSRF token" }, 403);
      }
    }

    let nextState: ClaimState;

    try {
      nextState = await runClaimNow(url.searchParams.get("profile") || "");
    } catch (error) {
      if (error instanceof ClaimInProgressError) {
        return jsonResponse({ ok: false, error: error.message }, 409);
      }

      throw error;
    }
    const accept = request.headers.get("accept") || "";

    if (accept.includes("text/html")) {
      return new Response(null, {
        status: 303,
        headers: { location: `${config.publicBasePath}/` },
      });
    }

    return jsonResponse({ ok: true, state: nextState });
  }

  if (!isAccessAuthorized(request, config)) {
    return unauthorizedResponse();
  }

  if (request.method === "GET" && pathname === "/api/status") {
    return jsonResponse(await getClaimState());
  }

  if (request.method === "GET" && pathname.startsWith("/assets/")) {
    let filename: string;

    try {
      filename = decodeURIComponent(pathname.slice("/assets/".length));
    } catch {
      return new Response("Not found", { status: 404 });
    }

    if (!config.profiles.some((profile) => profile.screenshotFilename === filename)) {
      return new Response("Not found", { status: 404 });
    }

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
      headers: htmlHeaders(),
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
    console.error("BrawlClaim failed:", error);
  });

  setInterval(() => {
    void runClaimNow().catch((error) => {
      console.error("BrawlClaim failed:", error);
    });
  }, config.intervalMs);

  console.log(
    `BrawlClaim enabled for ${config.profiles.length} profiles every ${Math.round(
      config.intervalMs / 60_000,
    )} minutes.`,
  );
}

function argumentValue(name: string) {
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === name) {
      return args[index + 1];
    }

    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }

  return undefined;
}

if (IS_CLAIM_ONCE) {
  const profileId =
    argumentValue("--profile") || readEnv("BRAWL_STARS_CLAIMER_PROFILE");
  const nextState = await runClaimNow(profileId);
  const output = profileId
    ? nextState.profiles[normalizeProfileId(profileId)]?.result || nextState
    : nextState;
  const results = profileId
    ? [nextState.profiles[normalizeProfileId(profileId)]?.result]
    : Object.values(nextState.profiles).map((profile) => profile.result);
  const exitCode = results.some((result) => result?.status === "error")
    ? 1
    : results.some((result) => result?.status === "login_required")
      ? 2
      : results.some((result) => result?.status === "claim_unconfirmed")
        ? 3
      : 0;

  console.log(JSON.stringify(output, null, 2));
  process.exit(exitCode);
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
