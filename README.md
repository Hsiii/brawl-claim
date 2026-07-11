# Brawl Stars Store Claimer

A small Bun and Playwright service for one job: opening the official Supercell
Store Brawl Stars page and claiming the visible daily reward button when the
saved auth state is logged in.

It does not bypass login challenges, captchas, email codes, or two-factor
prompts. If Supercell shows a login prompt, refresh the saved auth state.

## Setup

```bash
bun install
bunx playwright install chromium
bun run dev
```

Open `http://localhost:3100`.

## Commands

```bash
bun run claim
bun run auth:setup
```

`bun run claim` runs the claim flow once and writes status plus a screenshot
under the configured data directory.

`bun run auth:setup` starts a local-only helper page. Use it to open Supercell
Store in the dedicated auth profile, log into Supercell ID, save the Playwright
storage state, and upload it to Oracle.

## Configuration

Primary environment variables:

```env
BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH=/brawlstars
BRAWL_STARS_CLAIMER_DATA_DIR=/app/state
BRAWL_STARS_CLAIMER_AUTH_STATE_FILE=/app/state/auth.json
BRAWL_STARS_CLAIMER_ACCESS_USERNAME=
BRAWL_STARS_CLAIMER_ACCESS_PASSWORD=
BRAWL_STARS_CLAIMER_REFRESH_TOKEN=
BRAWL_STARS_CLAIMER_REWARD_SELECTORS=button:has-text("Claim"),button:has-text("Collect")
```

The old `MORNING_*` variables are still accepted as fallbacks during migration.

## Oracle

Production deployment is owned by the `oracle` runtime repo. The app is still
checked out on the VM at `/home/ubuntu/bots/apps/morning`, but the service is
deployed as the Brawl Stars Store Claimer.
