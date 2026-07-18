# BrawlClaim

BrawlClaim checks the official Supercell Store for visible Brawl Stars rewards,
claims them when available, and records evidence of the result. It can also send
each linked user a private daily update in Discord.

It uses a Supercell session created by the account owner and does not bypass
passwords, email codes, captchas, or two-factor authentication.

## Features

- Verified `claimed`, `claim_unconfirmed`, `no_reward`, and login/error results.
- Separate authentication, history, and screenshots for multiple profiles.
- Password-protected status dashboard and serialized claim jobs.
- Private Discord linking, ephemeral `/brawlclaim status`, and daily DMs.
- Docker image and Compose setup for self-hosting.

## Discord users

Ask the operator for a one-time code assigned to your profile, then run:

```text
/brawlclaim link code:<one-time-code>
```

After linking, use `/brawlclaim status` or `/brawlclaim unlink`.

Commands may be invoked in any channel where application commands are allowed,
but their replies are visible only to the person who ran them. Daily results go
to that linked user's DMs; BrawlClaim does not post account data publicly.

## Local setup

Requirements: [Bun](https://bun.sh/) and Google Chrome.

```bash
bun install
bunx playwright install chromium
cp .env.example .env.local
bun run auth:setup
```

Open the one-time localhost URL, select a profile, click **Open Store**, complete
Supercell sign-in, then click **Save**. Credentials are entered only on
Supercell's website, and the saved browser state is ignored by Git.

Run a check:

```bash
bun run claim -- --profile me
```

For Docker, scheduling, multiple profiles, production authentication, and
Discord operator setup, see [Self-hosting](docs/SELF_HOSTING.md).

## Development

```bash
bun install --frozen-lockfile
bun run build
bun audit
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
security issues using [SECURITY.md](SECURITY.md), not a public issue.

## Disclaimer

BrawlClaim is a personal automation tool and is not affiliated with, endorsed
by, or sponsored by Supercell. Brawl Stars and Supercell are trademarks of
Supercell.

Released under the [MIT License](LICENSE).
