# Morning Dashboard

A personal feed digest dashboard. It uses Playwright to collect the parts of
sites that are useful at a glance: timeline links, notification links, DM list
previews, recommendation cards, and targeted screenshots.

The app runs as a small Bun server. It collects on startup and on an interval,
stores JSON plus screenshots under `.data/screenshots`, and renders the digest
at `/`.

## Setup

```bash
bun install
bunx playwright install chromium
cp .env.example .env.local
bun run dev
```

Open `http://localhost:3100`.

Set `MORNING_ACCESS_USERNAME` and `MORNING_ACCESS_PASSWORD` before exposing the
server on a public domain. When both are set, every dashboard and API route
requires browser Basic Auth.

## Sources

Default sources are:

- X: screenshots the logged-in timeline and extracts 12 visible post links.
- Instagram: clicks the DM/inbox entry and screenshots the DM list preview only.
- Messenger: screenshots the chat list preview only.
- Facebook: opens notifications and extracts visible notification links.
- Anigamer: opens/reads the notification panel and extracts notification links.
- Supercell Store: checks the top section for a reward button and screenshots
  the store top area.
- YouTube: extracts the top 6 visible home recommendation links.

GitHub and Chrome Web Store are intentionally skipped.

Every section includes a source link. Open it from your Mac to use your normal
already-logged-in Chrome session.

## Auth State

Most feed sites are useful only when logged in. Save a Playwright storage state
after logging in:

```bash
bun run auth:setup
```

This opens a local-only setup page and launches your installed Google Chrome app
with a separate Chrome profile controlled through DevTools. Log in to the
sources there, save the storage state, then upload it to Oracle from the tool.
The tool does not receive or display passwords; it saves cookies and browser
storage only.

It intentionally does not attach to your normal Chrome profile. Chrome blocks
remote debugging against the default profile, and Playwright does not support
automating the main Chrome data directory. The setup profile persists at
`.data/auth-browser-profile`, so future refreshes should reuse those logins.
Override the Chrome path with `AUTH_TOOL_CHROME_PATH` if needed.

You can also use Playwright directly:

```bash
bunx playwright codegen --save-storage=.data/auth.json https://www.instagram.com/
```

Use the same browser session to log into the other sites you care about before
closing the codegen browser. Set `MORNING_AUTH_STATE_FILE=.data/auth.json`.

On Oracle, save the auth state to the mounted state path, for example
`/app/state/auth.json`, then set `MORNING_AUTH_STATE_FILE=/app/state/auth.json`.

## Manual refresh

If `MORNING_REFRESH_TOKEN` is set, manual refreshes require it:

```bash
curl -X POST \
  -H "Authorization: Bearer $MORNING_REFRESH_TOKEN" \
  http://localhost:3100/api/refresh
```

If the token is empty, `POST /api/refresh` is open on the local server.

## Supercell daily reward

Supercell Store reward clicking is off by default. After auth state is saved and
verified, set:

```env
MORNING_SUPERCELL_REWARD_ENABLED=true
```

The bot clicks the first selector from `MORNING_SUPERCELL_REWARD_SELECTORS` that
exists. It will not bypass login challenges, captchas, or two-factor prompts.

## Oracle Free deployment

Copy `.env.example` to `.env.local` and use state paths inside `/app/state`:

```env
MORNING_SCREENSHOT_DIR=/app/state/screenshots
MORNING_AUTH_STATE_FILE=/app/state/auth.json
```

Then deploy:

```bash
docker compose up -d --build
```

The dashboard listens on port `3100`.

For a subpath deployment such as `https://bot.hsichen.dev/morning/`, set:

```env
MORNING_PUBLIC_BASE_PATH=/morning
```
