import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3199;
const DEFAULT_AUTH_FILE = ".data/auth.json";
const DEFAULT_PROFILE_DIR = ".data/auth-browser-profile";
const DEFAULT_REMOTE_HOST = "oracle";
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_CDP_PORT = 9322;
const REMOTE_TMP_AUTH_FILE = "/tmp/morning-dashboard-auth.json";
const REMOTE_AUTH_FILE = "/app/state/auth.json";
const REMOTE_APP_DIR = "/home/ubuntu/bots/morning";
const DASHBOARD_URL = "https://bot.hsichen.dev/morning/";

type SourceConfig = {
  id: string;
  label: string;
  url: string;
  note: string;
};

const sources: SourceConfig[] = [
  {
    id: "x",
    label: "X",
    url: "https://twitter.com/home",
    note: "Timeline screenshot and visible post links.",
  },
  {
    id: "instagram",
    label: "Instagram",
    url: "https://www.instagram.com/direct/inbox/",
    note: "DM list preview only.",
  },
  {
    id: "messenger",
    label: "Messenger",
    url: "https://www.messenger.com/",
    note: "Chat list preview only.",
  },
  {
    id: "facebook",
    label: "Facebook",
    url: "https://www.facebook.com/",
    note: "Notification panel links.",
  },
  {
    id: "anigamer",
    label: "Anigamer",
    url: "https://ani.gamer.com.tw/",
    note: "Notification panel links.",
  },
  {
    id: "supercell",
    label: "Supercell Store",
    url: "https://store.supercell.com/brawlstars",
    note: "Reward status and store top section.",
  },
  {
    id: "youtube",
    label: "YouTube",
    url: "https://www.youtube.com/",
    note: "Home recommendations.",
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
const chromePath = process.env.AUTH_TOOL_CHROME_PATH || DEFAULT_CHROME_PATH;
const cdpPort = Number(process.env.AUTH_TOOL_CDP_PORT || DEFAULT_CDP_PORT);

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let chromeProcess: ReturnType<typeof Bun.spawn> | undefined;

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

async function getContext() {
  if (context) {
    return context;
  }

  await mkdir(profileDir, { recursive: true });
  chromeProcess = Bun.spawn(
    [
      chromePath,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "about:blank",
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  await waitForChromeDebugEndpoint();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  context = browser.contexts()[0];

  if (!context) {
    throw new Error("Chrome opened, but no browser context was available.");
  }

  return context;
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

async function openSource(source: SourceConfig) {
  const activeContext = await getContext();
  const page = await activeContext.newPage();

  await page.goto(source.url, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });

  return page;
}

async function listPages() {
  if (!context) {
    return [];
  }

  return context.pages().map((page: Page) => ({
    title: page.url() === "about:blank" ? "Blank" : page.url(),
    url: page.url(),
  }));
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
  const activeContext = await getContext();

  await mkdir(dirname(authFile), { recursive: true });
  await activeContext.storageState({
    path: authFile,
  });
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
cd ${REMOTE_APP_DIR}
sudo docker cp ${REMOTE_TMP_AUTH_FILE} morning-morning-dashboard-1:${REMOTE_AUTH_FILE}
sudo docker exec -u root morning-morning-dashboard-1 chown bun:bun ${REMOTE_AUTH_FILE}
sudo docker exec -u root morning-morning-dashboard-1 chmod 600 ${REMOTE_AUTH_FILE}
if grep -q '^MORNING_AUTH_STATE_FILE=' .env.local; then
  sed -i 's#^MORNING_AUTH_STATE_FILE=.*#MORNING_AUTH_STATE_FILE=${REMOTE_AUTH_FILE}#' .env.local
else
  printf '\\nMORNING_AUTH_STATE_FILE=${REMOTE_AUTH_FILE}\\n' >> .env.local
fi
sudo docker compose -f compose.oracle.yaml -p morning up -d --force-recreate
rm -f ${REMOTE_TMP_AUTH_FILE}
`;

  await runCommand(["ssh", remoteHost, remoteCommand]);

  return {
    remoteHost,
    remoteAuthFile: REMOTE_AUTH_FILE,
    dashboardUrl: DASHBOARD_URL,
  };
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
  <title>Morning Auth Setup</title>
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
        <h1>Morning Auth Setup</h1>
        <p>Local-only tool. Log in in the Playwright browser, save storage, then upload to Oracle.</p>
      </div>
      <a href="${DASHBOARD_URL}">Dashboard</a>
    </header>

    <section class="panel">
      <ol>
        <li>Click Open All, or open sources one by one.</li>
        <li>Log in directly in the browser windows. Do not enter passwords in this page.</li>
        <li>Click Save Auth State after all sites are logged in.</li>
        <li>Click Upload To Oracle. This copies only the Playwright storage JSON.</li>
      </ol>
    </section>

    <section class="actions">
      <button id="open-all">Open All</button>
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
      return json({
        browserOpen: Boolean(context),
        pages: await listPages(),
        auth: await readAuthSummary(),
        chromePath,
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
      await browser?.close().catch(() => undefined);
      chromeProcess?.kill();
      browser = undefined;
      context = undefined;
      chromeProcess = undefined;

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

console.log(`Morning auth setup listening at ${toolUrl}`);
console.log("This server is bound to localhost and uses a one-time URL token.");

process.on("SIGINT", async () => {
  await browser?.close().catch(() => undefined);
  chromeProcess?.kill();
  process.exit(0);
});
