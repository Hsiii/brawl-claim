# BrawlClaim

BrawlClaim is a focused Bun and Playwright service that opens the official
Supercell Store, checks the Brawl Stars page, and clicks a visible `Claim` or
`Collect` reward for a saved Supercell ID.

The production bot runs every day at **5:00 PM GMT+8**. It only uses a login
session you create yourself and does not bypass captchas, email codes,
two-factor authentication, or other Supercell security checks.

## First-Time Setup

Requirements:

- [Bun](https://bun.sh/) and Google Chrome on your Mac
- SSH access to the `platform` host for production upload and deployment

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
4. Click **Upload** to send the saved session to the platform host.

Passwords and verification codes are entered only on Supercell's website. The
helper stores browser state locally in `.data/auth.json`, uploads it with file
mode `0600`, and never asks for account credentials itself.

## Run A Check

Run BrawlClaim locally for the default `me` profile:

```bash
bun run claim -- --profile me
```

Possible results:

- `claimed`: the Store confirmed the reward after BrawlClaim clicked it.
- `claim_unconfirmed`: a reward control was clicked, but no success evidence appeared.
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
ssh platform /srv/platform/jobs/brawl-claimer/claim --profile me
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

## Private Discord Status

BrawlClaim can expose `/brawlclaim` slash commands without exposing one user's
claim data to another. Command responses are ephemeral, and linked users receive
their own daily result by DM. Supercell authentication never passes through
Discord.

Create a Discord application and bot, install it with the `bot` and
`applications.commands` scopes, and configure these secrets on the platform:

```env
BRAWL_CLAIM_DISCORD_APPLICATION_ID=...
BRAWL_CLAIM_DISCORD_PUBLIC_KEY=...
BRAWL_CLAIM_DISCORD_BOT_TOKEN=...
BRAWL_CLAIM_DISCORD_GUILD_ID=...
```

Set the application's Interactions Endpoint URL to:

```text
https://bot.hsichen.dev/brawlstars/api/discord/interactions
```

Register the commands. Setting `BRAWL_CLAIM_DISCORD_GUILD_ID` registers them in
one server immediately; omit it for global registration.

```bash
bun run discord:register
```

After a BrawlClaim profile has been authenticated and uploaded, create a
short-lived, one-time link code inside the production container:

```bash
ssh platform sudo docker compose \
  -f /srv/platform/operations/services/brawl-claimer/compose.yaml \
  exec brawl-claimer bun run discord:link-code -- --profile me
```

The user runs `/brawlclaim link code:<code>` in any channel where the command is
available. Only that user can see the response. They can then use
`/brawlclaim status` or `/brawlclaim unlink`; daily claim results arrive by DM.

## Configuration

The service reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRAWL_CLAIM_ENABLED` | `false` | Run the in-process scheduler in addition to manual requests |
| `BRAWL_STARS_CLAIMER_INTERVAL_MINUTES` | `1440` | In-process scheduler interval |
| `BRAWL_STARS_CLAIMER_PROFILES` | `me` | Comma-separated profile IDs or `id:Label` entries |
| `BRAWL_STARS_CLAIMER_AUTH_STATE_FILE` | profile data directory | Playwright storage-state file for the first profile |
| `BRAWL_STARS_CLAIMER_DATA_DIR` | `.data/brawl-claim` | Claim state and optional screenshots |
| `BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH` | empty | URL prefix such as `/brawlstars` |
| `BRAWL_STARS_CLAIMER_ALLOW_INSECURE_ACCESS` | `false` | Allow dashboard access without authentication; local development only |
| `BRAWL_STARS_CLAIMER_ACCESS_USERNAME` | empty | Dashboard Basic Auth username |
| `BRAWL_STARS_CLAIMER_ACCESS_PASSWORD` | empty | Dashboard Basic Auth password |
| `BRAWL_STARS_CLAIMER_REFRESH_TOKEN` | empty | Bearer token for remote claim requests |
| `BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS` | `180000` | Maximum duration of one profile check |
| `BRAWL_STARS_CLAIMER_REWARD_SELECTORS` | Claim/Collect buttons | Comma-separated Playwright selectors |
| `BRAWL_CLAIM_DISCORD_APPLICATION_ID` | empty | Discord application ID used to register slash commands |
| `BRAWL_CLAIM_DISCORD_PUBLIC_KEY` | empty | Ed25519 public key used to verify Discord interactions |
| `BRAWL_CLAIM_DISCORD_BOT_TOKEN` | empty | Bot token used to register commands and send private DMs |
| `BRAWL_CLAIM_DISCORD_GUILD_ID` | empty | Optional server ID for guild-scoped command registration |
| `BRAWL_CLAIM_DISCORD_LINK_CODE_TTL_MINUTES` | `15` | Lifetime of an admin-issued one-time link code |

For local dashboard development:

```bash
BRAWL_STARS_CLAIMER_ALLOW_INSECURE_ACCESS=true bun run dev
```

Then open [localhost:3100](http://localhost:3100).

## Disclaimer

This is a personal automation tool and is not affiliated with, endorsed by, or
sponsored by Supercell. Brawl Stars and Supercell are trademarks of Supercell.
