import { resolve } from "node:path";

import { createDiscordLinkCode } from "../src/discord";

function argumentValue(name: string) {
  const args = process.argv.slice(2);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === name) {
      return args[index + 1];
    }

    if (argument.startsWith(`${name}=`)) {
      return argument.slice(name.length + 1);
    }
  }

  return undefined;
}

function normalizeProfileId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const profileId = normalizeProfileId(argumentValue("--profile") || "");

if (!profileId) {
  console.error("Usage: bun run discord:link-code -- --profile <profile-id>");
  process.exit(1);
}

const configuredProfiles = new Set(
  (process.env.BRAWL_STARS_CLAIMER_PROFILES || "me")
    .split(",")
    .map((entry) => normalizeProfileId(entry.split(":")[0] || ""))
    .filter(Boolean),
);

if (!configuredProfiles.has(profileId)) {
  console.error(`Unknown BrawlClaim profile: ${profileId}`);
  process.exit(1);
}

const dataDir = resolve(
  process.env.BRAWL_STARS_CLAIMER_DATA_DIR || ".data/brawl-claim",
);
const ttlMinutes =
  Number(process.env.BRAWL_CLAIM_DISCORD_LINK_CODE_TTL_MINUTES) || 15;
const linkCode = await createDiscordLinkCode({
  dataDir,
  profileId,
  ttlMinutes,
});

console.log(`Discord link code for ${profileId}: ${linkCode.code}`);
console.log(`Expires at: ${linkCode.expiresAt}`);
