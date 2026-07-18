export {};

const applicationId = process.env.BRAWL_CLAIM_DISCORD_APPLICATION_ID;
const botToken = process.env.BRAWL_CLAIM_DISCORD_BOT_TOKEN;
const guildId = process.env.BRAWL_CLAIM_DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  console.error(
    "BRAWL_CLAIM_DISCORD_APPLICATION_ID and BRAWL_CLAIM_DISCORD_BOT_TOKEN are required.",
  );
  process.exit(1);
}

const commands = [
  {
    name: "brawlclaim",
    description: "Privately manage your linked BrawlClaim profile",
    options: [
      {
        type: 1,
        name: "link",
        description: "Link your Discord account with a one-time code",
        options: [
          {
            type: 3,
            name: "code",
            description: "One-time link code from the BrawlClaim operator",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "status",
        description: "Show only your linked profile's latest claim status",
      },
      {
        type: 1,
        name: "unlink",
        description: "Remove your Discord account link",
      },
    ],
  },
];
const scope = guildId
  ? `applications/${applicationId}/guilds/${guildId}/commands`
  : `applications/${applicationId}/commands`;
const response = await fetch(`https://discord.com/api/v10/${scope}`, {
  method: "PUT",
  headers: {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(
    `Discord command registration failed (${response.status}): ${await response.text()}`,
  );
  process.exit(1);
}

console.log(
  `Registered /brawlclaim commands ${guildId ? `for guild ${guildId}` : "globally"}.`,
);
