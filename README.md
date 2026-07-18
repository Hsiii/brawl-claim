# BrawlClaim

BrawlClaim checks the official Supercell Store for a visible Brawl Stars reward,
claims it when available, and records evidence of the result. The hosted service
runs every day at **5:00 PM GMT+8** and can privately notify each linked user in
Discord.

It uses a Supercell login session created by the account owner. It does not ask
for or bypass passwords, email codes, captchas, two-factor authentication, or
other Supercell security checks.

## What You Get

- A daily check for visible `Claim` or `Collect` rewards.
- Verified outcomes instead of assuming that a click succeeded.
- A password-protected web dashboard with the latest status and evidence.
- Separate Supercell sessions and claim history for multiple profiles.
- Private Discord account linking, status checks, and daily result DMs.
- Serialized claim and link updates so overlapping jobs cannot corrupt state.

The hosted dashboard is at
[bot.hsichen.dev/brawlstars](https://bot.hsichen.dev/brawlstars/).

## Using BrawlClaim in Discord

If a server administrator has not installed the hosted bot yet, use
[Install BrawlClaim](https://discord.com/oauth2/authorize?client_id=1528020358748176515&permissions=0&integration_type=0&scope=bot%20applications.commands).
Discord will ask which server should receive the application; BrawlClaim
requests no ordinary server permissions.

Ask the BrawlClaim operator for a one-time code assigned to your profile, then
run:

```text
/brawlclaim link code:<one-time-code>
```

The code expires after 15 minutes by default and works only once. After linking,
you can use:

```text
/brawlclaim status
/brawlclaim unlink
```

### Where Discord messages appear

- You can run a command in any server channel where application commands are
  allowed.
- Command replies are **ephemeral**: only the person who ran the command sees
  the result.
- Daily results are sent directly to the linked user by **DM**.
- BrawlClaim does not post account status or rewards into a public channel.
- An unlinked Discord user cannot read another profile's data.

If the command is missing, confirm that BrawlClaim is installed in the server.
If daily DMs do not arrive, confirm that you still share that server with the bot
and allow DMs from server members.

## Connect a Supercell Account

Each account owner must complete their own Supercell sign-in locally.

### Requirements

- [Bun](https://bun.sh/)
- Google Chrome
- SSH access to the `platform` host when uploading to the hosted service

Install the project and browser runtime:

```bash
bun install
bunx playwright install chromium
```

Start the local auth helper:

```bash
bun run auth:setup
```

Open the one-time localhost URL printed in the terminal, then:

1. Select the profile you want to configure.
2. Click **Open Store**.
3. Sign in to Supercell ID in the dedicated Chrome window.
4. Return to the helper and click **Save**.
5. Click **Upload** to send that saved browser session to the platform.

Credentials and verification codes are entered only on Supercell's website.
The helper stores browser state locally in `.data/auth.json`, uploads it with
file mode `0600`, and never asks for the account password itself.

### Add more profiles

The default profile is `me`. Add profiles with comma-separated IDs:

```bash
AUTH_TOOL_PROFILES=me,friend1,friend2 bun run auth:setup
```

Add user-facing labels with `id:Label` entries:

```bash
AUTH_TOOL_PROFILES='me:Hsi,friend1:Alex,friend2:Sam' bun run auth:setup
```

Every person should sign in to their own account and save/upload only their
selected profile. Profiles have separate auth files, screenshots, claim results,
and Discord links.

## Check a Reward Manually

Run a local check for the default profile:

```bash
bun run claim -- --profile me
```

The result is one of:

| Result | Meaning |
| --- | --- |
| `claimed` | The Store showed success evidence after BrawlClaim clicked the reward. |
| `claim_unconfirmed` | A reward control was clicked, but success could not be verified. |
| `no_reward` | The session is valid, but no visible reward is available. |
| `login_required` | The saved Supercell session needs to be refreshed. |
| `error` | The Store or browser did not complete the check. |

## Production Operations

Oracle runs BrawlClaim as the `brawl-claimer` Compose service. A systemd timer
starts the daily job at `09:00 UTC`, which is `17:00 GMT+8`, and persists across
reboots.

Useful commands:

```bash
ssh platform /srv/platform/jobs/brawl-claimer/claim --profile me
ssh platform systemctl status platform-brawlstars-claim.timer
ssh platform journalctl -u platform-brawlstars-claim.service
ssh platform /srv/platform/operations/scripts/status
```

Application commits publish Linux AMD64 images to
`ghcr.io/hsiii/brawl-stars-store-claimer`. Production uses an immutable
`sha-<commit>` tag pinned in the Oracle operations repository. After publishing
an image, update the pin in `services/brawl-claimer/compose.yaml`, then deploy:

```bash
ssh platform /srv/platform/operations/scripts/deploy-brawl-claimer
```

The persistent Docker volume is named `brawl-stars-claimer_state`; replacing the
container does not replace saved auth, claim history, or Discord links.

## Discord Operator Setup

1. Create a Discord application and bot named **BrawlClaim**.
2. Store these values in `/srv/platform/secrets/brawl-claimer.env` with mode
   `0600`:

   ```env
   BRAWL_CLAIM_DISCORD_APPLICATION_ID=...
   BRAWL_CLAIM_DISCORD_PUBLIC_KEY=...
   BRAWL_CLAIM_DISCORD_BOT_TOKEN=...
   BRAWL_CLAIM_DISCORD_GUILD_ID=...
   ```

   `BRAWL_CLAIM_DISCORD_GUILD_ID` is optional. Set it for immediate,
   server-scoped command registration; omit it to register globally.

3. Set the application's Interactions Endpoint URL to:

   ```text
   https://bot.hsichen.dev/brawlstars/api/discord/interactions
   ```

4. Install the application with the `bot` and `applications.commands` scopes.
   BrawlClaim needs no ordinary server permissions (`permissions=0`) and no
   privileged Gateway intents.
5. Register the commands from the configured production container:

   ```bash
   ssh platform sudo docker compose \
     -f /srv/platform/operations/services/brawl-claimer/compose.yaml \
     exec -T brawl-claimer bun run discord:register
   ```

6. Generate a one-time code for an authenticated profile:

   ```bash
   ssh platform sudo docker compose \
     -f /srv/platform/operations/services/brawl-claimer/compose.yaml \
     exec -T brawl-claimer bun run discord:link-code -- --profile me
   ```

Give that code only to the Discord user who owns the profile. Generating another
code for the same profile invalidates the previous active code. A Discord user
can link to only one profile, and a profile can belong to only one Discord user.

## Configuration

Copy `.env.example` for local development. Production secrets belong in
`/srv/platform/secrets/brawl-claimer.env` and must never be committed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | HTTP bind address |
| `PORT` | `3100` | HTTP port |
| `BRAWL_CLAIM_ENABLED` | `false` | Enable the in-process scheduler; `.env.example` enables it locally, while production leaves it off because systemd owns the schedule |
| `BRAWL_STARS_CLAIMER_INTERVAL_MINUTES` | `1440` | In-process scheduler interval |
| `BRAWL_STARS_CLAIMER_PROFILES` | `me` | Comma-separated profile IDs or `id:Label` entries |
| `BRAWL_STARS_CLAIMER_AUTH_STATE_FILE` | profile data directory | Storage-state file for the first profile |
| `BRAWL_STARS_CLAIMER_DATA_DIR` | `.data/brawl-claim` | Claim state, screenshots, and Discord links |
| `BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH` | empty | URL prefix such as `/brawlstars` |
| `BRAWL_STARS_CLAIMER_ALLOW_INSECURE_ACCESS` | `false` | Disable dashboard authentication for local development only |
| `BRAWL_STARS_CLAIMER_ACCESS_USERNAME` | empty | Dashboard Basic Auth username |
| `BRAWL_STARS_CLAIMER_ACCESS_PASSWORD` | empty | Dashboard Basic Auth password |
| `BRAWL_STARS_CLAIMER_REFRESH_TOKEN` | empty | Bearer token for remote claim requests |
| `BRAWL_STARS_CLAIMER_CLAIM_TIMEOUT_MS` | `180000` | Maximum duration of one profile check |
| `BRAWL_STARS_CLAIMER_REWARD_SELECTORS` | Claim/Collect buttons | Comma-separated Playwright selectors |
| `BRAWL_CLAIM_DISCORD_APPLICATION_ID` | empty | Discord application ID used to register commands |
| `BRAWL_CLAIM_DISCORD_PUBLIC_KEY` | empty | Ed25519 key used to verify signed interactions |
| `BRAWL_CLAIM_DISCORD_BOT_TOKEN` | empty | Secret used to register commands and send DMs |
| `BRAWL_CLAIM_DISCORD_GUILD_ID` | empty | Optional server ID for guild-scoped registration |
| `BRAWL_CLAIM_DISCORD_LINK_CODE_TTL_MINUTES` | `15` | One-time link-code lifetime |

Run the local dashboard without access credentials only during development:

```bash
BRAWL_STARS_CLAIMER_ALLOW_INSECURE_ACCESS=true bun run dev
```

Then open [localhost:3100](http://localhost:3100).

## Security and Privacy

- Supercell authentication happens only in a dedicated local Chrome profile.
- Stored browser state, production secrets, link codes, and profile links use
  restrictive file permissions.
- Link codes are stored as hashes, expire automatically, and are consumed once.
- Discord verifies the public interaction endpoint with Ed25519 signatures.
- Dashboard access uses Basic Auth; state-changing requests also require CSRF or
  bearer-token authorization.
- Discord status replies are ephemeral, and daily results are sent by DM.

## Disclaimer

BrawlClaim is a personal automation tool and is not affiliated with, endorsed
by, or sponsored by Supercell. Brawl Stars and Supercell are trademarks of
Supercell.
