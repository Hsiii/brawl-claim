import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3199;
const DEFAULT_AUTH_FILE = ".data/auth.json";
const DEFAULT_PROFILE_DIR = ".data/auth-browser-profile";
const DEFAULT_REMOTE_HOST = "oracle";
const DEFAULT_CHROME_APP_NAME = "Google Chrome";
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CDP_PORT = 9322;
const REMOTE_TMP_AUTH_FILE = "/tmp/brawl-stars-claimer-auth.json";
const REMOTE_AUTH_FILE = "/app/state/auth.json";
const REMOTE_ORACLE_DIR = "/home/ubuntu/bots/oracle";
const REMOTE_ENV_FILE = "/home/ubuntu/bots/secrets/brawl-stars-claimer.env";
const DASHBOARD_URL = "https://bot.hsichen.dev/brawlstars/";

type SourceConfig = {
  id: string;
  label: string;
  url: string;
  note: string;
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

const sources: SourceConfig[] = [
  {
    id: "supercell",
    label: "Brawl Stars Store",
    url: "https://store.supercell.com/brawlstars",
    note: "Login state used by the daily reward claimer.",
  },
];

const token = crypto.randomUUID();
const host = process.env.AUTH_TOOL_HOST || DEFAULT_HOST;
const port = Number(process.env.AUTH_TOOL_PORT || DEFAULT_PORT);
const authFile = resolve(process.env.AUTH_TOOL_AUTH_FILE || DEFAULT_AUTH_FILE);
const profileDir = resolve(
  process.env.AUTH_TOOL_PROFILE_DIR || DEFAULT_PROFILE_DIR,
);
const remoteHost = process.env.AUTH_TOOL_REMOTE_HOST || DEFAULT_REMOTE_HOST;
const chromeAppName =
  process.env.AUTH_TOOL_CHROME_APP_NAME || DEFAULT_CHROME_APP_NAME;
const chromePath = process.env.AUTH_TOOL_CHROME_PATH || DEFAULT_CHROME_PATH;
const cdpPort = Number(process.env.AUTH_TOOL_CDP_PORT || DEFAULT_CDP_PORT);

let chromeProcess: ReturnType<typeof Bun.spawn> | undefined;
let chromeLauncher = "not-started";

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

async function ensureChrome() {
  await mkdir(profileDir, { recursive: true });
  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
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

async function openSource(source: SourceConfig) {
  await ensureChrome();

  const blankTarget = (await listChromeTargets()).find(
    (target) => target.type === "page" && target.url === "about:blank",
  );

  return blankTarget
    ? navigateTarget(blankTarget, source.url)
    : createChromeTarget(source.url);
}

async function listPages() {
  if (!(await isChromeDebugEndpointReady())) {
    return [];
  }

  return (await listChromeTargets())
    .filter((target) => target.type === "page")
    .map((target) => ({
      title:
        target.title || (target.url === "about:blank" ? "Blank" : target.url),
      url: target.url,
    }));
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

async function readChromeStorageState(): Promise<StorageState> {
  await ensureChrome();

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

async function readAuthSummary() {
  if (!existsSync(authFile)) {
    return {
      exists: false,
      path: authFile,
    };
  }

  const raw = await readFile(authFile, "utf8");
  const parsed = JSON.parse(raw) as {
    cookies?: Array<{ domain?: string; name?: string }>;
    origins?: Array<{ origin: string }>;
  };
  const cookieDomains = [
    ...new Set(
      parsed.cookies
        ?.map((cookie) => cookie.domain?.replace(/^\./, ""))
        .filter(Boolean) ?? [],
    ),
  ].sort();

  return {
    exists: true,
    path: authFile,
    size: (await stat(authFile)).size,
    cookieCount: parsed.cookies?.length ?? 0,
    cookieDomains,
    origins: parsed.origins?.map((origin) => origin.origin).sort() ?? [],
  };
}

async function saveAuthState() {
  const storageState = await readChromeStorageState();

  await mkdir(dirname(authFile), { recursive: true });
  await writeFile(authFile, `${JSON.stringify(storageState, null, 2)}\n`);
  await chmod(authFile, 0o600);

  return readAuthSummary();
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

async function uploadAuthState() {
  if (!existsSync(authFile)) {
    throw new Error("No auth file saved yet. Save first, then upload.");
  }

  await runCommand([
    "scp",
    authFile,
    `${remoteHost}:${REMOTE_TMP_AUTH_FILE}`,
  ]);

  const remoteCommand = `
set -e
container_id="$(sudo docker compose -f ${REMOTE_ORACLE_DIR}/compose.yaml ps -q brawl-stars-claimer)"
if [ -z "$container_id" ]; then
  ${REMOTE_ORACLE_DIR}/scripts/deploy-brawlstars
  container_id="$(sudo docker compose -f ${REMOTE_ORACLE_DIR}/compose.yaml ps -q brawl-stars-claimer)"
fi
sudo docker cp ${REMOTE_TMP_AUTH_FILE} "$container_id:${REMOTE_AUTH_FILE}"
sudo docker exec -u root "$container_id" chown bun:bun ${REMOTE_AUTH_FILE}
sudo docker exec -u root "$container_id" chmod 600 ${REMOTE_AUTH_FILE}
if grep -q '^BRAWL_STARS_CLAIMER_AUTH_STATE_FILE=' ${REMOTE_ENV_FILE}; then
  sed -i 's#^BRAWL_STARS_CLAIMER_AUTH_STATE_FILE=.*#BRAWL_STARS_CLAIMER_AUTH_STATE_FILE=${REMOTE_AUTH_FILE}#' ${REMOTE_ENV_FILE}
else
  printf '\\nBRAWL_STARS_CLAIMER_AUTH_STATE_FILE=${REMOTE_AUTH_FILE}\\n' >> ${REMOTE_ENV_FILE}
fi
${REMOTE_ORACLE_DIR}/scripts/deploy-brawlstars
rm -f ${REMOTE_TMP_AUTH_FILE}
`;

  await runCommand(["ssh", remoteHost, remoteCommand]);

  return {
    remoteHost,
    remoteAuthFile: REMOTE_AUTH_FILE,
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
}

function renderPage() {
  const sourceCards = sources
    .map(
      (source) => `<article class="source-card">
        <div>
          <h2>${escapeHtml(source.label)}</h2>
          <p>${escapeHtml(source.note)}</p>
        </div>
        <button data-open="${escapeHtml(source.id)}">Open</button>
      </article>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brawl Stars Claimer Auth Setup</title>
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
      width: min(1120px, 100%);
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
    h2 { font-size: 17px; line-height: 1.3; }
    p, li { color: var(--color-muted); }
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
    .actions, .grid {
      display: grid;
      gap: var(--space-3);
    }
    .actions {
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      margin-bottom: var(--space-6);
    }
    .grid {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      margin-bottom: var(--space-6);
    }
    .panel, .source-card {
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
      padding: var(--space-4);
    }
    .source-card {
      display: flex;
      justify-content: space-between;
      gap: var(--space-4);
      align-items: center;
    }
    .status-ok { color: var(--color-success); }
    .status-error { color: var(--color-error); }
    pre {
      min-height: 160px;
      overflow: auto;
      padding: var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-card);
      background: #0c0e10;
      color: var(--color-text);
    }
    @media (max-width: 720px) {
      main { padding: var(--space-4); }
      header { display: block; }
      .source-card { display: block; }
      .source-card button { margin-top: var(--space-3); width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Brawl Stars Claimer Auth Setup</h1>
        <p>Local-only tool. Log into Supercell Store in the dedicated Chrome auth profile, save storage, then upload to Oracle.</p>
      </div>
      <a href="${DASHBOARD_URL}">Claimer</a>
    </header>

    <section class="panel">
      <ol>
        <li>Open Brawl Stars Store and complete Supercell ID login.</li>
        <li>Log in directly in the browser windows. Do not enter passwords in this page.</li>
        <li>Click Save Auth State after all sites are logged in.</li>
        <li>Click Upload To Oracle. This copies only the Playwright storage JSON.</li>
      </ol>
    </section>

    <section class="actions">
      <button id="open-all">Open Store</button>
      <button id="save">Save Auth State</button>
      <button id="upload">Upload To Oracle</button>
      <button id="status">Refresh Status</button>
      <button id="close">Close Browser</button>
    </section>

    <section class="grid">${sourceCards}</section>

    <section class="panel">
      <h2>Status</h2>
      <pre id="output">Ready.</pre>
    </section>
  </main>

  <script>
    const token = ${JSON.stringify(token)};
    const output = document.querySelector("#output");
    const write = (value, ok = true) => {
      output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      output.className = ok ? "status-ok" : "status-error";
    };
    const call = async (path, body) => {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-auth-tool-token": token
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;

      if (!response.ok) {
        throw new Error(payload?.error || response.statusText);
      }

      return payload;
    };
    const run = async (task) => {
      try {
        write("Working...");
        write(await task());
      } catch (error) {
        write(error instanceof Error ? error.message : String(error), false);
      }
    };

    document.querySelector("#open-all").addEventListener("click", () => {
      run(() => call("/api/open-all", {}));
    });
    document.querySelector("#save").addEventListener("click", () => {
      run(() => call("/api/save", {}));
    });
    document.querySelector("#upload").addEventListener("click", () => {
      run(() => call("/api/upload", {}));
    });
    document.querySelector("#status").addEventListener("click", () => {
      run(() => call("/api/status"));
    });
    document.querySelector("#close").addEventListener("click", () => {
      run(() => call("/api/close", {}));
    });
    document.querySelectorAll("[data-open]").forEach((button) => {
      button.addEventListener("click", () => {
        run(() => call("/api/open", { source: button.dataset.open }));
      });
    });

    run(() => call("/api/status"));
  </script>
</body>
</html>`;
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
        pages: browserOpen ? await listPages() : [],
        auth: await readAuthSummary(),
        chromeAppName,
        chromePath,
        chromeLauncher,
        profileDir,
        cdpPort,
        remoteHost,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/open") {
      const body = (await request.json()) as { source?: string };
      const source = sources.find((item) => item.id === body.source);

      if (!source) {
        return json({ error: "Unknown source" }, 400);
      }

      await openSource(source);

      return json({
        opened: source.label,
        pages: await listPages(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/open-all") {
      for (const source of sources) {
        await openSource(source);
      }

      return json({
        opened: sources.map((source) => source.label),
        pages: await listPages(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/save") {
      return json({
        saved: await saveAuthState(),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      return json({
        uploaded: await uploadAuthState(),
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
