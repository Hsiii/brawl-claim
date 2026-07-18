import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3199;
const DEFAULT_AUTH_FILE = ".data/auth.json";
const DEFAULT_AUTH_DIR = ".data/auth";
const DEFAULT_PROFILE_DIR = ".data/auth-browser-profile";
const DEFAULT_PROFILE_ROOT = ".data/auth-browser-profiles";
const DEFAULT_PROFILES = "me";
const DEFAULT_REMOTE_HOST = "platform";
const DEFAULT_CHROME_APP_NAME = "Google Chrome";
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CDP_PORT = 9322;
const REMOTE_TMP_AUTH_FILE_PREFIX = "/tmp/brawl-stars-claimer-auth";
const REMOTE_DEFAULT_AUTH_FILE = "/app/state/auth.json";
const REMOTE_PROFILE_AUTH_ROOT = "/app/state/profiles";
const REMOTE_INFRA_DIR = "/srv/platform/infra";
const REMOTE_ENV_FILE = "/srv/platform/secrets/brawl-stars-claimer.env";
const DASHBOARD_URL = "https://bot.hsichen.dev/brawlstars/";
const STORE_URL = "https://store.supercell.com/brawlstars";

type AuthProfile = {
  authFile: string;
  id: string;
  label: string;
  profileDir: string;
  remoteAuthFile: string;
  remoteTmpAuthFile: string;
};

type ChromeTarget = {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type CdpCookie = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
};

type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{
      name: string;
      value: string;
    }>;
  }>;
};

const token = crypto.randomUUID();
const host = process.env.AUTH_TOOL_HOST || DEFAULT_HOST;
const port = Number(process.env.AUTH_TOOL_PORT || DEFAULT_PORT);
const remoteHost = process.env.AUTH_TOOL_REMOTE_HOST || DEFAULT_REMOTE_HOST;
const chromeAppName =
  process.env.AUTH_TOOL_CHROME_APP_NAME || DEFAULT_CHROME_APP_NAME;
const chromePath = process.env.AUTH_TOOL_CHROME_PATH || DEFAULT_CHROME_PATH;
const cdpPort = Number(process.env.AUTH_TOOL_CDP_PORT || DEFAULT_CDP_PORT);

let chromeProcess: ReturnType<typeof Bun.spawn> | undefined;
let chromeLauncher = "not-started";
let activeProfileId: string | undefined;

function normalizeProfileId(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "me"
  );
}

function profileDisplayName(id: string) {
  if (id === "me") {
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

  return `AUTH_TOOL_${envId}_${suffix}`;
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

function buildProfiles(): AuthProfile[] {
  const rawProfiles =
    process.env.AUTH_TOOL_PROFILES ||
    process.env.BRAWL_STARS_CLAIMER_PROFILES ||
    DEFAULT_PROFILES;
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
      : [{ id: "me", label: "Me" }];

  return profiles.map((profile, index) => {
    const authFile =
      process.env[profileEnvKey(profile.id, "AUTH_FILE")] ||
      (index === 0 ? process.env.AUTH_TOOL_AUTH_FILE : undefined) ||
      (index === 0 ? DEFAULT_AUTH_FILE : join(DEFAULT_AUTH_DIR, `${profile.id}.json`));
    const profileDir =
      process.env[profileEnvKey(profile.id, "PROFILE_DIR")] ||
      (index === 0 ? process.env.AUTH_TOOL_PROFILE_DIR : undefined) ||
      (index === 0 ? DEFAULT_PROFILE_DIR : join(DEFAULT_PROFILE_ROOT, profile.id));
    const remoteAuthFile =
      process.env[profileEnvKey(profile.id, "REMOTE_AUTH_FILE")] ||
      (index === 0
        ? REMOTE_DEFAULT_AUTH_FILE
        : `${REMOTE_PROFILE_AUTH_ROOT}/${profile.id}/auth.json`);

    return {
      ...profile,
      authFile: resolve(authFile),
      profileDir: resolve(profileDir),
      remoteAuthFile,
      remoteTmpAuthFile: `${REMOTE_TMP_AUTH_FILE_PREFIX}-${profile.id}.json`,
    };
  });
}

const profiles = buildProfiles();

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function assertAuthorized(request: Request) {
  const url = new URL(request.url);
  const requestToken =
    request.headers.get("x-auth-tool-token") || url.searchParams.get("token");

  if (requestToken !== token) {
    return false;
  }

  return true;
}

function findProfile(profileId: string | undefined) {
  if (!profileId) {
    return profiles[0];
  }

  const normalizedId = normalizeProfileId(profileId);

  return profiles.find((profile) => profile.id === normalizedId) || profiles[0];
}

async function ensureChrome(profile = profiles[0]) {
  if (
    activeProfileId &&
    activeProfileId !== profile.id &&
    (await isChromeDebugEndpointReady())
  ) {
    await closeChrome();
  }

  await mkdir(profile.profileDir, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile.profileDir}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ];

  if (await isChromeDebugEndpointReady()) {
    chromeLauncher = "existing-cdp";
  } else if (
    process.platform === "darwin" &&
    !process.env.AUTH_TOOL_CHROME_PATH
  ) {
    chromeLauncher = "macos-open";
    chromeProcess = Bun.spawn(
      ["open", "-na", chromeAppName, "--args", ...chromeArgs],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
  } else {
    chromeLauncher = "chrome-path";
    chromeProcess = Bun.spawn([chromePath, ...chromeArgs], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  await waitForChromeDebugEndpoint();
  activeProfileId = profile.id;
}

async function isChromeDebugEndpointReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);

    return response.ok;
  } catch {
    return false;
  }
}

async function waitForChromeDebugEndpoint() {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 20_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Could not connect to Chrome DevTools on port ${cdpPort}. ${lastError instanceof Error ? lastError.message : ""}`.trim(),
  );
}

async function chromeJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}${path}`, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Chrome DevTools request failed: ${response.status} ${text}`.trim(),
    );
  }

  return (text ? JSON.parse(text) : null) as T;
}

async function getBrowserWebSocketUrl() {
  const version = await chromeJson<{ webSocketDebuggerUrl?: string }>(
    "/json/version",
  );

  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools did not expose a browser WebSocket URL.");
  }

  return version.webSocketDebuggerUrl;
}

async function listChromeTargets() {
  return chromeJson<ChromeTarget[]>("/json/list");
}

async function activateChromeTarget(targetId: string) {
  await fetch(`http://127.0.0.1:${cdpPort}/json/activate/${targetId}`).catch(
    () => undefined,
  );
}

async function createChromeTarget(url: string) {
  const target = await chromeJson<ChromeTarget>(
    `/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  await activateChromeTarget(target.id);

  return target;
}

class CdpConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(private readonly ws: WebSocket) {
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
      };

      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const request = this.pending.get(message.id);

      if (!request) {
        return;
      }

      clearTimeout(request.timeout);
      this.pending.delete(message.id);

      if (message.error) {
        request.reject(
          new Error(message.error.message || "Chrome DevTools call failed."),
        );
        return;
      }

      request.resolve(message.result);
    };
    this.ws.onclose = () => {
      for (const [id, request] of this.pending) {
        clearTimeout(request.timeout);
        request.reject(new Error("Chrome DevTools WebSocket closed."));
        this.pending.delete(id);
      }
    };
  }

  static connect(url: string) {
    return new Promise<CdpConnection>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out connecting to Chrome DevTools at ${url}`));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve(new CdpConnection(ws));
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to Chrome DevTools at ${url}`));
      };
    });
  }

  call<T>(method: string, params: Record<string, unknown> = {}) {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools call timed out: ${method}`));
      }, 10_000);

      this.pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
        timeout,
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
        }),
      );
    });
  }

  close() {
    this.ws.close();
  }
}

async function navigateTarget(target: ChromeTarget, url: string) {
  if (!target.webSocketDebuggerUrl) {
    return createChromeTarget(url);
  }

  const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);

  try {
    await cdp.call("Page.enable").catch(() => undefined);
    await cdp.call("Page.navigate", { url });
    await activateChromeTarget(target.id);

    return {
      ...target,
      title: url,
      url,
    };
  } finally {
    cdp.close();
  }
}

async function openStore(profile = profiles[0]) {
  await ensureChrome(profile);

  const blankTarget = (await listChromeTargets()).find(
    (target) => target.type === "page" && target.url === "about:blank",
  );

  return blankTarget
    ? navigateTarget(blankTarget, STORE_URL)
    : createChromeTarget(STORE_URL);
}

function normalizeSameSite(value: string | undefined) {
  if (value === "Strict" || value === "None") {
    return value;
  }

  return "Lax";
}

function normalizeCookie(cookie: CdpCookie) {
  if (!cookie.name || !cookie.domain || !cookie.path) {
    return undefined;
  }

  return {
    name: cookie.name,
    value: cookie.value ?? "",
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : cookie.expires ?? -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function localStorageEntries(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("name" in entry) ||
        !("value" in entry)
      ) {
        return undefined;
      }

      return {
        name: String(entry.name),
        value: String(entry.value),
      };
    })
    .filter((entry): entry is { name: string; value: string } =>
      Boolean(entry),
    );
}

async function readOpenTargetLocalStorage() {
  const origins = new Map<string, StorageState["origins"][number]>();
  const targets = (await listChromeTargets()).filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      /^https?:\/\//.test(target.url),
  );

  for (const target of targets) {
    const origin = new URL(target.url).origin;

    if (origins.has(origin) || !target.webSocketDebuggerUrl) {
      continue;
    }

    const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);

    try {
      const result = await cdp.call<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
            const entries = [];
            for (let index = 0; index < localStorage.length; index += 1) {
              const name = localStorage.key(index);
              if (name) {
                entries.push({ name, value: localStorage.getItem(name) || "" });
              }
            }
            return entries;
          })()`,
          returnByValue: true,
        },
      );
      const localStorage = localStorageEntries(result.result?.value);

      if (localStorage.length > 0) {
        origins.set(origin, {
          origin,
          localStorage,
        });
      }
    } finally {
      cdp.close();
    }
  }

  return [...origins.values()].sort((a, b) =>
    a.origin.localeCompare(b.origin),
  );
}

async function readChromeStorageState(profile = profiles[0]): Promise<StorageState> {
  await ensureChrome(profile);

  const cdp = await CdpConnection.connect(await getBrowserWebSocketUrl());

  try {
    const result = await cdp.call<{ cookies?: CdpCookie[] }>(
      "Storage.getCookies",
    );
    const cookies = (result.cookies ?? [])
      .map(normalizeCookie)
      .filter((cookie): cookie is StorageState["cookies"][number] =>
        Boolean(cookie),
      );

    return {
      cookies,
      origins: await readOpenTargetLocalStorage(),
    };
  } finally {
    cdp.close();
  }
}

async function readAuthSummary(profile = profiles[0]) {
  if (!existsSync(profile.authFile)) {
    return {
      exists: false,
      profileId: profile.id,
      profileLabel: profile.label,
    };
  }

  const raw = await readFile(profile.authFile, "utf8");
  const parsed = JSON.parse(raw) as {
    cookies?: Array<{ domain?: string; name?: string }>;
  };

  return {
    exists: true,
    profileId: profile.id,
    profileLabel: profile.label,
    cookieCount: parsed.cookies?.length ?? 0,
  };
}

async function saveAuthState(profile = profiles[0]) {
  const storageState = await readChromeStorageState(profile);

  await mkdir(dirname(profile.authFile), { recursive: true });
  await writeFile(profile.authFile, `${JSON.stringify(storageState, null, 2)}\n`);
  await chmod(profile.authFile, 0o600);

  return readAuthSummary(profile);
}

async function runCommand(command: string[], options?: { input?: string }) {
  const process = Bun.spawn(command, {
    stdin: options?.input ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (options?.input && process.stdin) {
    process.stdin.write(options.input);
    process.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `${command[0]} exited ${exitCode}\n${stdout.trim()}\n${stderr.trim()}`.trim(),
    );
  }

  return {
    stdout,
    stderr,
  };
}

async function uploadAuthState(profile = profiles[0]) {
  if (!existsSync(profile.authFile)) {
    throw new Error("No auth file saved yet. Save first, then upload.");
  }

  await runCommand([
    "scp",
    profile.authFile,
    `${remoteHost}:${profile.remoteTmpAuthFile}`,
  ]);

  const profileList = profiles.map((item) => item.id).join(",");
  const remoteCommand = `
set -e
desired_profiles='${profileList}'
desired_auth_file='${REMOTE_DEFAULT_AUTH_FILE}'
remote_env_file='${REMOTE_ENV_FILE}'
remote_auth_file='${profile.remoteAuthFile}'
needs_deploy=0
set_env() {
  key="$1"
  value="$2"
  if grep -q "^$key=" "$remote_env_file"; then
    current="$(grep "^$key=" "$remote_env_file" | tail -n 1 | cut -d= -f2-)"
    if [ "$current" != "$value" ]; then
      sed -i "s#^$key=.*#$key=$value#" "$remote_env_file"
      needs_deploy=1
    fi
  else
    printf '\\n%s=%s\\n' "$key" "$value" >> "$remote_env_file"
    needs_deploy=1
  fi
}
container_id="$(sudo docker compose -f ${REMOTE_INFRA_DIR}/compose.yaml ps -q brawl-stars-claimer)"
if [ -z "$container_id" ]; then
  ${REMOTE_INFRA_DIR}/scripts/deploy-brawlstars
  container_id="$(sudo docker compose -f ${REMOTE_INFRA_DIR}/compose.yaml ps -q brawl-stars-claimer)"
fi
sudo docker exec -u root "$container_id" mkdir -p "$(dirname "$remote_auth_file")"
sudo docker cp ${profile.remoteTmpAuthFile} "$container_id:$remote_auth_file"
sudo docker exec -u root "$container_id" chown bun:bun "$remote_auth_file"
sudo docker exec -u root "$container_id" chmod 600 "$remote_auth_file"
set_env BRAWL_STARS_CLAIMER_PROFILES "$desired_profiles"
set_env BRAWL_STARS_CLAIMER_AUTH_STATE_FILE "$desired_auth_file"
if [ "$needs_deploy" = "1" ]; then
  ${REMOTE_INFRA_DIR}/scripts/deploy-brawlstars
fi
rm -f ${profile.remoteTmpAuthFile}
`;

  await runCommand(["ssh", remoteHost, remoteCommand]);

  return {
    remoteHost,
    profileId: profile.id,
    profileLabel: profile.label,
    remoteAuthFile: profile.remoteAuthFile,
    dashboardUrl: DASHBOARD_URL,
  };
}

async function closeChrome() {
  if (await isChromeDebugEndpointReady()) {
    const cdp = await CdpConnection.connect(await getBrowserWebSocketUrl());

    try {
      await cdp.call("Browser.close").catch(() => undefined);
    } finally {
      cdp.close();
    }
  }

  chromeProcess?.kill();
  chromeProcess = undefined;
  chromeLauncher = "not-started";
  activeProfileId = undefined;
}

function renderPage() {
  const profileField =
    profiles.length > 1
      ? `<div class="field">
        <label for="profile">Profile</label>
        <select id="profile">${profiles
          .map(
            (profile) =>
              `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.label)}</option>`,
          )
          .join("")}</select>
      </div>`
      : `<input id="profile" type="hidden" value="${escapeHtml(profiles[0].id)}">`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brawl Stars Store Claimer - Auth Setup</title>
  <style>
    :root {
      --color-bg: #111315;
      --color-surface: #191b1f;
      --color-surface-raised: #20242a;
      --color-code: #0c0e10;
      --color-border: #343842;
      --color-text: #edf4ef;
      --color-muted: #a5abb7;
      --color-accent: #8ab4ff;
      --color-success: #80d39b;
      --color-error: #ff8a80;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-6: 24px;
      --space-8: 32px;
      --radius-card: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(720px, 100%);
      margin: 0 auto;
      padding: var(--space-8);
    }
    header, .status-head {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: end;
    }
    header { margin-bottom: var(--space-6); }
    h1, h2, p { margin: 0; }
    h1 { font-size: 28px; line-height: 1.2; }
    h2 { font-size: 17px; line-height: 1.3; }
    p { color: var(--color-muted); }
    a { color: var(--color-accent); }
    button, select {
      min-height: 40px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface-raised);
      color: var(--color-text);
    }
    button {
      padding: 0 var(--space-4);
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { border-color: var(--color-accent); }
    .actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .field {
      display: grid;
      gap: var(--space-2);
    }
    label { color: var(--color-muted); }
    select { padding: 0 var(--space-3); }
    .panel {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      padding: var(--space-4);
      margin-bottom: var(--space-4);
      display: grid;
      gap: var(--space-4);
    }
    .status-ok { color: var(--color-success); }
    .status-error { color: var(--color-error); }
    pre {
      min-height: 120px;
      overflow: auto;
      padding: var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-code);
      color: var(--color-text);
      margin: 0;
      white-space: pre-wrap;
    }
    @media (max-width: 720px) {
      main { padding: var(--space-4); }
      header, .status-head { display: grid; align-items: start; }
      .actions { grid-template-columns: 1fr; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Auth Setup</h1>
        <p>Save your Supercell Store login for scheduled claims.</p>
      </div>
      <a href="${DASHBOARD_URL}">Claimer</a>
    </header>

    <section class="panel">
      ${profileField}
      <div class="actions">
        <button id="open">Open Store</button>
        <button id="save">Save</button>
        <button id="upload">Upload</button>
      </div>
    </section>

    <section class="panel">
      <div class="status-head">
        <h2>Status</h2>
        <button id="status">Refresh</button>
      </div>
      <pre id="output">Ready.</pre>
    </section>
  </main>

  <script>
    const token = ${JSON.stringify(token)};
    const profiles = ${JSON.stringify(profiles.map((profile) => ({ id: profile.id, label: profile.label })))};
    const output = document.querySelector("#output");
    const profileSelect = document.querySelector("#profile");
    const write = (value, ok = true) => {
      output.textContent = value;
      output.className = ok ? "status-ok" : "status-error";
    };
    const selectedProfile = () => profileSelect.value;
    const selectedProfileLabel = () => {
      return profiles.find((profile) => profile.id === selectedProfile())?.label || selectedProfile();
    };
    const call = async (path, body) => {
      const payload = body ? { profile: selectedProfile(), ...body } : undefined;
      const response = await fetch(path, {
        method: payload ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-auth-tool-token": token
        },
        body: payload ? JSON.stringify(payload) : undefined
      });
      const text = await response.text();
      const result = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(result?.error || response.statusText);
      }

      return result;
    };
    const formatStatus = (payload) => {
      const rows = payload.auth.map((item) => {
        return item.exists
          ? item.profileLabel + ": saved (" + item.cookieCount + " cookies)"
          : item.profileLabel + ": not saved";
      });
      rows.unshift(payload.browserOpen ? "Chrome: open" : "Chrome: closed");
      return rows.join("\\n");
    };
    const run = async (task, formatter = (value) => value?.message || "Done.") => {
      try {
        write("Working...");
        write(formatter(await task()));
      } catch (error) {
        write(error instanceof Error ? error.message : String(error), false);
      }
    };

    document.querySelector("#open").addEventListener("click", () => {
      run(
        () => call("/api/open", {}),
        () => "Opened store for " + selectedProfileLabel() + "."
      );
    });
    document.querySelector("#save").addEventListener("click", () => {
      run(
        () => call("/api/save", {}),
        (value) => "Saved " + value.saved.profileLabel + " locally (" + value.saved.cookieCount + " cookies)."
      );
    });
    document.querySelector("#upload").addEventListener("click", () => {
      run(
        () => call("/api/upload", {}),
        (value) => "Uploaded " + value.uploaded.profileLabel + " to Oracle."
      );
    });
    document.querySelector("#status").addEventListener("click", () => {
      run(() => call("/api/status"), formatStatus);
    });
    if (profileSelect.tagName === "SELECT") {
      profileSelect.addEventListener("change", () => {
        run(() => call("/api/status"), formatStatus);
      });
    }

    run(() => call("/api/status"), formatStatus);
  </script>
</body>
</html>`;
}

async function readJsonRequest(request: Request) {
  try {
    return (await request.json()) as { profile?: string };
  } catch {
    return {};
  }
}

async function handleRequest(request: Request) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") !== token) {
      return new Response("Unauthorized", { status: 401 });
    }

    return new Response(renderPage(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  if (!assertAuthorized(request)) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/status") {
      const browserOpen = await isChromeDebugEndpointReady();

      return json({
        browserOpen,
        auth: await Promise.all(
          profiles.map((profile) => readAuthSummary(profile)),
        ),
        profiles: profiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
        })),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/open") {
      const body = await readJsonRequest(request);
      const profile = findProfile(body.profile);

      await openStore(profile);

      return json({
        opened: true,
        profile: profile.label,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/save") {
      const body = await readJsonRequest(request);
      const profile = findProfile(body.profile);

      return json({
        saved: await saveAuthState(profile),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      const body = await readJsonRequest(request);
      const profile = findProfile(body.profile);

      return json({
        uploaded: await uploadAuthState(profile),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/close") {
      await closeChrome();

      return json({
        closed: true,
      });
    }
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }

  return new Response("Not found", { status: 404 });
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch: handleRequest,
});

const toolUrl = `http://${server.hostname}:${server.port}/?token=${token}`;

console.log(`Brawl Stars auth setup listening at ${toolUrl}`);
console.log("This server is bound to localhost and uses a one-time URL token.");

process.on("SIGINT", async () => {
  await closeChrome().catch(() => undefined);
  process.exit(0);
});
