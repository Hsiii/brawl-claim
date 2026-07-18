# Brawl Stars Store Claimer

A focused Bun and Playwright service that opens the official Supercell Store,
checks the Brawl Stars page, and clicks a visible `Claim` or `Collect` reward
for a saved Supercell ID.

The production bot runs every day at **5:00 PM GMT+8**. It only uses a login
session you create yourself and does not bypass captchas, email codes,
two-factor authentication, or other Supercell security checks.

## First-Time Setup

Requirements:

- [Bun](https://bun.sh/) and Google Chrome on your Mac
- SSH access to the `oracle` host for production upload and deployment

Install the project and Playwright browser:

```bash
bun install
bunx playwright install chromium
```

Start the local auth helper:

```bash
bun run auth:setup
```

Open the one-time localhost URL printed in the terminal, then:

1. Click **Open Store**.
2. Sign in to your Supercell ID in the dedicated Chrome window.
3. Return to the auth helper and click **Save**.
4. Click **Upload** to send the saved session to Oracle.

Passwords and verification codes are entered only on Supercell's website. The
helper stores browser state locally in `.data/auth.json`, uploads it with file
mode `0600`, and never asks for account credentials itself.

## Run A Check

Run the claimer locally for the default `me` profile:

```bash
bun run claim -- --profile me
```

Possible results:

- `claimed`: a visible reward button was clicked.
- `no_reward`: login is valid, but no reward button is currently available.
- `login_required`: the saved Supercell session must be refreshed.
- `error`: the store or browser did not complete the check.

The production dashboard is available at
[bot.hsichen.dev/brawlstars](https://bot.hsichen.dev/brawlstars/).

## Daily Schedule

The shared platform host owns the production service and its systemd timer. The timer runs at
`09:00:00 UTC`, which is `17:00:00 GMT+8`, and persists across reboots.

Useful operator commands:

```bash
ssh platform /srv/platform/infra/scripts/claim-brawlstars-reward --profile me
ssh platform systemctl status platform-brawlstars-claim.timer
ssh platform journalctl -u platform-brawlstars-claim.service
```

Deploy committed changes from `main` with:

```bash
bun run deploy
```

## Optional Friend Profiles

The default setup contains only `me`. Friends are opt-in and each person gets a
separate Chrome profile, auth file, dashboard status, and claim run.

Start auth setup with additional profiles:

```bash
AUTH_TOOL_PROFILES=me,friend1,friend2 bun run auth:setup
```

You can add display names with `id:Label` entries:

```bash
AUTH_TOOL_PROFILES='me:Hsi,friend1:Alex,friend2:Sam' bun run auth:setup
```

Each friend should sign in to their own Supercell ID, then use **Save** and
**Upload** for that selected profile. To return production to one account, run
the helper without `AUTH_TOOL_PROFILES` and upload `me` again.

## Configuration

The service reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAWL_STARS_CLAIMER_PROFILES` | `me` | Comma-separated profile IDs or `id:Label` entries |
| `BRAWL_STARS_CLAIMER_AUTH_STATE_FILE` | profile data directory | Playwright storage-state file for the first profile |
| `BRAWL_STARS_CLAIMER_DATA_DIR` | `.data/brawl-stars-claimer` | Claim state and optional screenshots |
| `BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH` | empty | URL prefix such as `/brawlstars` |
| `BRAWL_STARS_CLAIMER_ACCESS_USERNAME` | empty | Optional dashboard Basic Auth username |
| `BRAWL_STARS_CLAIMER_ACCESS_PASSWORD` | empty | Optional dashboard Basic Auth password |
| `BRAWL_STARS_CLAIMER_REFRESH_TOKEN` | empty | Optional bearer token for remote claim requests |
| `BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS` | `180000` | Maximum duration of one profile check |
| `BRAWL_STARS_CLAIMER_REWARD_SELECTORS` | Claim/Collect buttons | Comma-separated Playwright selectors |

For local dashboard development:

```bash
bun run dev
```

Then open [localhost:3100](http://localhost:3100).

## Disclaimer

This is a personal automation tool and is not affiliated with, endorsed by, or
sponsored by Supercell. Brawl Stars and Supercell are trademarks of Supercell.
