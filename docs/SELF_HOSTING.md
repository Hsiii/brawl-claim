# Self-hosting BrawlClaim

## Let friends use it

The safest setup is for each friend to run their own private instance. Send them
the repository URL and have them follow [Local setup](../README.md#local-setup),
then this guide if they want Docker or Discord. Each person keeps their own
`.env.local` and `.data/` directory and signs in directly on Supercell's website.

For an always-on personal instance, set these values after copying
`.env.example`:

```env
BRAWL_CLAIM_ENABLED=true
BRAWL_STARS_CLAIMER_PROFILES=me
BRAWL_STARS_CLAIMER_ACCESS_USERNAME=operator
BRAWL_STARS_CLAIMER_ACCESS_PASSWORD=<random-password>
```

Then authenticate and start it:

```bash
bun run auth:setup
bun run claim -- --profile me
bun run start
```

The dashboard is at `http://localhost:3100`. Do not expose it directly to the
internet: use HTTPS through a trusted reverse proxy or private network first.
For an always-on Docker deployment instead, follow
[Run with Docker Compose](#run-with-docker-compose) after authentication.

Alternatively, one trusted operator can host several friends on one instance.
This is more convenient, but the operator's state volume contains reusable
Supercell browser sessions for every account. Only use this model when every
account owner understands and accepts that trust relationship.

Choose stable profile IDs and configure all of them in `.env.local`:

```env
BRAWL_STARS_CLAIMER_PROFILES=me:Me,alice:Alice,bob:Bob
```

On the operator's computer, install the local requirements once and run:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
bun run auth:setup
```

Select one profile at a time. Its owner should complete the Supercell sign-in
and click **Save** without giving the operator their email code. The helper saves
the first profile to `.data/auth.json` and later profiles to files such as
`.data/auth/alice.json` and `.data/auth/bob.json`.

After starting Compose, copy each saved session into its matching container
path:

```bash
docker compose up -d --build
docker compose cp .data/auth.json brawl-claimer:/app/state/auth.json
docker compose exec -u root brawl-claimer mkdir -p /app/state/profiles/alice /app/state/profiles/bob
docker compose cp .data/auth/alice.json brawl-claimer:/app/state/profiles/alice/auth.json
docker compose cp .data/auth/bob.json brawl-claimer:/app/state/profiles/bob/auth.json
docker compose exec -u root brawl-claimer chown -R bun:bun /app/state
docker compose exec -u root brawl-claimer chmod 600 /app/state/auth.json /app/state/profiles/alice/auth.json /app/state/profiles/bob/auth.json
docker compose restart brawl-claimer
```

Run `docker compose exec -T brawl-claimer bun run claim` to check every profile,
or add `-- --profile alice` to check only Alice. If Discord is enabled, generate
one link code per profile and privately give each code to its account owner.

## Configure the service

Copy the sample environment and replace every credential placeholder you use:

```bash
cp .env.example .env.local
```

At minimum, set strong dashboard credentials:

```env
BRAWL_STARS_CLAIMER_ACCESS_USERNAME=operator
BRAWL_STARS_CLAIMER_ACCESS_PASSWORD=<random-password>
```

`BRAWL_CLAIM_ENABLED` is off by default. Leave it off when an external cron or
systemd timer runs claim jobs. Set it to `true` only when this process should run
its own interval scheduler.

## Authenticate a Supercell profile

Run the local helper:

```bash
bun run auth:setup
```

Select a profile, open the Store, complete Supercell sign-in, and save. The
default local auth file is `.data/auth.json`.

For multiple profiles, provide IDs or `id:Label` entries:

```bash
AUTH_TOOL_PROFILES='me:Me,friend:Friend' bun run auth:setup
```

Each account owner should sign in to their own profile. Configure matching
`BRAWL_STARS_CLAIMER_PROFILES` and per-profile auth paths before running claims.

The helper shows only local controls by default. Set `AUTH_TOOL_REMOTE_HOST` to
enable its operator-specific SSH upload action and `AUTH_TOOL_DASHBOARD_URL` to
show a dashboard link.

## Run with Docker Compose

Build and start the service:

```bash
docker compose up -d --build
docker compose cp .data/auth.json brawl-claimer:/app/state/auth.json
docker compose exec -u root brawl-claimer chown bun:bun /app/state/auth.json
docker compose exec -u root brawl-claimer chmod 600 /app/state/auth.json
docker compose restart brawl-claimer
```

Compose stores auth, claim history, screenshots, and Discord links in the named
`brawl-claimer-state` volume. The dashboard is available on port `3100` and
requires the Basic Auth credentials from `.env.local`.

Run a manual production check:

```bash
docker compose exec -T brawl-claimer bun run claim -- --profile me
```

Published Linux AMD64 images use `ghcr.io/hsiii/brawl-claim` with `main` and
`sha-<commit>` tags.

## Configure Discord

Create a Discord application and bot, then add these values to `.env.local` or
your production secret store:

```env
BRAWL_CLAIM_DISCORD_APPLICATION_ID=...
BRAWL_CLAIM_DISCORD_PUBLIC_KEY=...
BRAWL_CLAIM_DISCORD_BOT_TOKEN=...
BRAWL_CLAIM_DISCORD_GUILD_ID=...
```

The guild ID is optional. It registers commands immediately in one server;
without it, commands are registered globally.

Expose the service over HTTPS and set Discord's Interactions Endpoint URL to:

```text
https://<your-host>/<optional-base-path>/api/discord/interactions
```

Install the application with the `bot` and `applications.commands` scopes.
BrawlClaim needs no ordinary server permissions (`permissions=0`) and no
privileged Gateway intents.

Register the slash commands:

```bash
docker compose exec -T brawl-claimer bun run discord:register
```

Generate a 15-minute, single-use code for an authenticated profile:

```bash
docker compose exec -T brawl-claimer \
  bun run discord:link-code -- --profile me
```

Give the code only to that profile's owner. One Discord user can link to one
profile, and one profile can link to one Discord user.

## Important environment variables

| Variable | Purpose |
| --- | --- |
| `BRAWL_CLAIM_ENABLED` | Enable the in-process scheduler |
| `BRAWL_STARS_CLAIMER_PROFILES` | Comma-separated `id` or `id:Label` profiles |
| `BRAWL_STARS_CLAIMER_AUTH_STATE_FILE` | First profile's Playwright storage state |
| `BRAWL_STARS_CLAIMER_DATA_DIR` | Claim state, screenshots, and Discord links |
| `BRAWL_STARS_CLAIMER_PUBLIC_BASE_PATH` | Reverse-proxy prefix, such as `/brawlstars` |
| `BRAWL_STARS_CLAIMER_ACCESS_USERNAME` | Dashboard Basic Auth username |
| `BRAWL_STARS_CLAIMER_ACCESS_PASSWORD` | Dashboard Basic Auth password |
| `BRAWL_STARS_CLAIMER_REFRESH_TOKEN` | Bearer token for remote claim requests |
| `BRAWL_CLAIM_DISCORD_LINK_CODE_TTL_MINUTES` | Link-code lifetime; default `15` |

See [.env.example](../.env.example) for the complete list.

## Security notes

- Never commit `.env*`, `.data/`, browser state, screenshots, or tokens.
- Keep the dashboard behind HTTPS and strong authentication.
- Store production environment files and browser state with mode `0600`.
- Back up the state volume securely; it contains authenticated browser state.
- The Discord interaction route is public by design and verifies Ed25519
  signatures before handling commands.
