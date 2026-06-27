# Morning Dashboard

A personal Playwright screenshot dashboard for the sites opened by Homepage's
`/feeds` command.

The app runs as a small Bun server. It captures screenshots on startup and on an
interval, stores them under `.data/screenshots`, and renders them at `/`.

## Setup

```bash
bun install
bunx playwright install chromium
cp .env.example .env.local
bun run dev
```

Open `http://localhost:3100`.

## Auth state

Most feed sites are useful only when logged in. Save a Playwright storage state
after logging in:

```bash
bunx playwright codegen --save-storage=.data/auth.json https://www.instagram.com/
```

Use the same browser session to log into the other sites you care about before
closing the codegen browser. Set `MORNING_AUTH_STATE_FILE=.data/auth.json`.

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
