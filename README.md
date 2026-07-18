# Brawl Stars Store Claimer

A small Bun and Playwright service for one job: opening the official Supercell
Store Brawl Stars page and claiming the visible daily reward button for each
configured profile when its saved auth state is logged in.

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

`bun run claim` runs the claim flow once for all configured profiles and writes
status plus screenshots under the configured data directory. To run one profile:

```bash
bun run claim -- --profile friend1
```

`bun run auth:setup` starts a local-only helper page for your account. Open the
Supercell Store, log into Supercell ID, save the Playwright storage state, and
upload it to Oracle.

Friend profiles are optional. To configure them later, start the helper with:

```bash
AUTH_TOOL_PROFILES=me,friend1,friend2 bun run auth:setup
```

## Configuration

Primary environment variables:

```env
BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH=/brawlstars
BRAWL_STARS_CLAIMER_DATA_DIR=/app/state
BRAWL_STARS_CLAIMER_PROFILES=me
BRAWL_STARS_CLAIMER_AUTH_STATE_FILE=/app/state/auth.json
BRAWL_STARS_CLAIMER_ACCESS_USERNAME=
BRAWL_STARS_CLAIMER_ACCESS_PASSWORD=
BRAWL_STARS_CLAIMER_REFRESH_TOKEN=
BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS=180000
BRAWL_STARS_CLAIMER_REWARD_SELECTORS=button:has-text("Claim"),button:has-text("Collect")
```

`BRAWL_STARS_CLAIMER_PROFILES` is a comma-separated list of profile IDs. Use
`id:Label` when you want friendlier names, for example
`me:Hsi,friend1:Alex,friend2:Sam`. The first profile keeps using
`BRAWL_STARS_CLAIMER_AUTH_STATE_FILE`; later profiles default to
`/app/state/profiles/<id>/auth.json`.

The old `MORNING_*` variables are still accepted as fallbacks during migration.

## Oracle

Production deployment is owned by the `oracle` runtime repo. The app is still
checked out on the VM at `/home/ubuntu/bots/apps/morning`, but the service is
deployed as the Brawl Stars Store Claimer.
