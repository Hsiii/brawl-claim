import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_EPHEMERAL_FLAG = 64;
const DISCORD_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const DISCORD_PUBLIC_KEY_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const LINKS_FILE = "discord-links.json";
const LINK_CODES_FILE = "discord-link-codes.json";

export type DiscordProfile = {
  id: string;
  label: string;
};

export type DiscordClaimResult = {
  status: string;
  attempted: boolean;
  claimed: boolean;
  checkedAt: string;
  message: string;
  verification: string;
  verificationEvidence: string[];
};

type DiscordLink = {
  discordUserId: string;
  linkedAt: string;
};

type DiscordLinks = {
  profiles: Record<string, DiscordLink>;
  version: 1;
};

type DiscordLinkCode = {
  expiresAt: string;
  hash: string;
  profileId: string;
};

type DiscordLinkCodes = {
  codes: DiscordLinkCode[];
  version: 1;
};

type InteractionOption = {
  name: string;
  options?: InteractionOption[];
  value?: string | number | boolean;
};

type DiscordInteraction = {
  type: number;
  data?: {
    name?: string;
    options?: InteractionOption[];
  };
  member?: {
    user?: { id?: string };
  };
  user?: { id?: string };
};

type DiscordInteractionOptions = {
  dataDir: string;
  getResult: (profileId: string) => Promise<DiscordClaimResult | undefined>;
  profiles: DiscordProfile[];
  publicKey?: string;
};

type DiscordNotificationOptions = {
  botToken?: string;
  dataDir: string;
  results: Array<{
    profile: DiscordProfile;
    result: DiscordClaimResult;
  }>;
};

let linkMutationQueue: Promise<void> = Promise.resolve();

function linksPath(dataDir: string) {
  return join(dataDir, LINKS_FILE);
}

function linkCodesPath(dataDir: string) {
  return join(dataDir, LINK_CODES_FILE);
}

function isMissingFile(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

async function readJson<T>(path: string, fallback: T) {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissingFile(error)) {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;

  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!isMissingFile(error)) {
        throw error;
      }
    });
  }
}

function withLinkMutation<T>(operation: () => Promise<T>) {
  const result = linkMutationQueue.then(operation, operation);

  linkMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function hashLinkCode(code: string) {
  return createHash("sha256").update(code.trim()).digest("hex");
}

function emptyLinks(): DiscordLinks {
  return { profiles: {}, version: 1 };
}

function emptyLinkCodes(): DiscordLinkCodes {
  return { codes: [], version: 1 };
}

export async function createDiscordLinkCode({
  dataDir,
  profileId,
  ttlMinutes = 15,
}: {
  dataDir: string;
  profileId: string;
  ttlMinutes?: number;
}) {
  return withLinkMutation(async () => {
    const path = linkCodesPath(dataDir);
    const stored = await readJson(path, emptyLinkCodes());
    const now = Date.now();
    const code = randomBytes(8).toString("base64url");
    const expiresAt = new Date(now + ttlMinutes * 60_000).toISOString();
    const codes = stored.codes.filter(
      (candidate) =>
        Date.parse(candidate.expiresAt) > now && candidate.profileId !== profileId,
    );

    codes.push({ expiresAt, hash: hashLinkCode(code), profileId });
    await writeJsonAtomic(path, { codes, version: 1 } satisfies DiscordLinkCodes);

    return { code, expiresAt, profileId };
  });
}

async function consumeDiscordLinkCode({
  code,
  dataDir,
  discordUserId,
  profiles,
}: {
  code: string;
  dataDir: string;
  discordUserId: string;
  profiles: DiscordProfile[];
}) {
  return withLinkMutation(async () => {
    const now = Date.now();
    const codes = await readJson(linkCodesPath(dataDir), emptyLinkCodes());
    const activeCodes = codes.codes.filter(
      (candidate) => Date.parse(candidate.expiresAt) > now,
    );
    const codeHash = hashLinkCode(code);
    const match = activeCodes.find((candidate) => candidate.hash === codeHash);

    if (!match) {
      await writeJsonAtomic(linkCodesPath(dataDir), {
        codes: activeCodes,
        version: 1,
      } satisfies DiscordLinkCodes);
      throw new Error("That link code is invalid or expired.");
    }

    const profile = profiles.find((candidate) => candidate.id === match.profileId);

    if (!profile) {
      throw new Error("The profile for that link code is no longer configured.");
    }

    const links = await readJson(linksPath(dataDir), emptyLinks());
    const existingProfile = Object.entries(links.profiles).find(
      ([, link]) => link.discordUserId === discordUserId,
    );
    const existingUser = links.profiles[profile.id];

    if (existingProfile && existingProfile[0] !== profile.id) {
      throw new Error("Your Discord account is already linked to another profile.");
    }

    if (existingUser && existingUser.discordUserId !== discordUserId) {
      throw new Error("That BrawlClaim profile is already linked to another user.");
    }

    links.profiles[profile.id] = {
      discordUserId,
      linkedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(linksPath(dataDir), links);
    await writeJsonAtomic(linkCodesPath(dataDir), {
      codes: activeCodes.filter((candidate) => candidate.hash !== codeHash),
      version: 1,
    } satisfies DiscordLinkCodes);

    return profile;
  });
}

async function unlinkDiscordUser(dataDir: string, discordUserId: string) {
  return withLinkMutation(async () => {
    const path = linksPath(dataDir);
    const links = await readJson(path, emptyLinks());
    const entry = Object.entries(links.profiles).find(
      ([, link]) => link.discordUserId === discordUserId,
    );

    if (!entry) {
      return undefined;
    }

    delete links.profiles[entry[0]];
    await writeJsonAtomic(path, links);

    return entry[0];
  });
}

async function linkedProfileForUser(
  dataDir: string,
  discordUserId: string,
  profiles: DiscordProfile[],
) {
  const links = await readJson(linksPath(dataDir), emptyLinks());
  const profileId = Object.entries(links.profiles).find(
    ([, link]) => link.discordUserId === discordUserId,
  )?.[0];

  return profiles.find((profile) => profile.id === profileId);
}

function ephemeralMessage(content: string) {
  return {
    type: 4,
    data: {
      allowed_mentions: { parse: [] },
      content,
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  };
}

function interactionUserId(interaction: DiscordInteraction) {
  return interaction.member?.user?.id || interaction.user?.id;
}

function subcommand(interaction: DiscordInteraction) {
  return interaction.data?.options?.[0];
}

function stringOption(option: InteractionOption | undefined, name: string) {
  const value = option?.options?.find((candidate) => candidate.name === name)?.value;

  return typeof value === "string" ? value : undefined;
}

function statusEmoji(status: string) {
  if (status === "claimed") {
    return "✅";
  }

  if (status === "no_reward") {
    return "☑️";
  }

  if (status === "claim_unconfirmed") {
    return "⚠️";
  }

  return "❌";
}

function formatPrivateStatus(profile: DiscordProfile, result?: DiscordClaimResult) {
  if (!result) {
    return `**${profile.label}** has not been checked yet.`;
  }

  const checkedAt = new Date(result.checkedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Taipei",
  });
  const evidence = result.verificationEvidence[0]
    ? `\nEvidence: ${result.verificationEvidence[0]}`
    : "";

  return `${statusEmoji(result.status)} **${profile.label}** — ${result.status.replaceAll("_", " ")}\n${result.message}\nChecked: ${checkedAt}${evidence}`;
}

function verifyDiscordRequest(request: Request, body: string, publicKey: string) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");

  if (
    !signature ||
    !timestamp ||
    !/^[a-f0-9]{128}$/i.test(signature) ||
    !/^[a-f0-9]{64}$/i.test(publicKey)
  ) {
    return false;
  }

  const timestampMs = Number(timestamp) * 1000;

  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > DISCORD_SIGNATURE_MAX_AGE_MS
  ) {
    return false;
  }

  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([DISCORD_PUBLIC_KEY_PREFIX, Buffer.from(publicKey, "hex")]),
    type: "spki",
  });

  return verifySignature(
    null,
    Buffer.from(`${timestamp}${body}`),
    key,
    Buffer.from(signature, "hex"),
  );
}

export async function handleDiscordInteraction(
  request: Request,
  options: DiscordInteractionOptions,
) {
  if (!options.publicKey) {
    return new Response("Discord integration is not configured", { status: 503 });
  }

  const body = await request.text();

  if (!verifyDiscordRequest(request, body, options.publicKey)) {
    return new Response("Invalid request signature", { status: 401 });
  }

  let interaction: DiscordInteraction;

  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (interaction.type === 1) {
    return Response.json({ type: 1 });
  }

  if (interaction.type !== 2 || interaction.data?.name !== "brawlclaim") {
    return Response.json(ephemeralMessage("Unsupported BrawlClaim interaction."));
  }

  const discordUserId = interactionUserId(interaction);
  const command = subcommand(interaction);

  if (!discordUserId || !command) {
    return Response.json(ephemeralMessage("Discord did not provide a user or command."));
  }

  try {
    if (command.name === "link") {
      const code = stringOption(command, "code");

      if (!code) {
        throw new Error("A link code is required.");
      }

      const profile = await consumeDiscordLinkCode({
        code,
        dataDir: options.dataDir,
        discordUserId,
        profiles: options.profiles,
      });

      return Response.json(
        ephemeralMessage(
          `Linked **${profile.label}**. Daily results will be sent privately by DM.`,
        ),
      );
    }

    if (command.name === "status") {
      const profile = await linkedProfileForUser(
        options.dataDir,
        discordUserId,
        options.profiles,
      );

      if (!profile) {
        throw new Error("Your Discord account is not linked to a BrawlClaim profile.");
      }

      return Response.json(
        ephemeralMessage(
          formatPrivateStatus(profile, await options.getResult(profile.id)),
        ),
      );
    }

    if (command.name === "unlink") {
      const profileId = await unlinkDiscordUser(options.dataDir, discordUserId);

      return Response.json(
        ephemeralMessage(
          profileId
            ? "Your BrawlClaim profile was unlinked."
            : "Your Discord account was not linked.",
        ),
      );
    }

    return Response.json(ephemeralMessage("Unknown BrawlClaim command."));
  } catch (error) {
    return Response.json(
      ephemeralMessage(error instanceof Error ? error.message : "Discord command failed."),
    );
  }
}

async function discordApiRequest(
  botToken: string,
  path: string,
  body: Record<string, unknown>,
  retry = true,
): Promise<Response> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bot ${botToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 429 && retry) {
    const rateLimit = (await response.json().catch(() => ({}))) as {
      retry_after?: number;
    };
    const retryAfterMs = Math.min(
      Math.max(Number(rateLimit.retry_after || 1) * 1000, 250),
      10_000,
    );

    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return discordApiRequest(botToken, path, body, false);
  }

  if (!response.ok) {
    throw new Error(
      `Discord API ${path} failed with ${response.status}: ${await response.text()}`,
    );
  }

  return response;
}

async function sendDiscordDm(
  botToken: string,
  discordUserId: string,
  content: string,
) {
  const channelResponse = await discordApiRequest(botToken, "/users/@me/channels", {
    recipient_id: discordUserId,
  });
  const channel = (await channelResponse.json()) as { id?: string };

  if (!channel.id) {
    throw new Error("Discord did not return a DM channel.");
  }

  await discordApiRequest(botToken, `/channels/${channel.id}/messages`, {
    allowed_mentions: { parse: [] },
    content,
  });
}

export async function notifyLinkedDiscordUsers({
  botToken,
  dataDir,
  results,
}: DiscordNotificationOptions) {
  if (!botToken || results.length === 0) {
    return;
  }

  const links = await readJson(linksPath(dataDir), emptyLinks());

  await Promise.allSettled(
    results.map(async ({ profile, result }) => {
      const discordUserId = links.profiles[profile.id]?.discordUserId;

      if (!discordUserId) {
        return;
      }

      await sendDiscordDm(
        botToken,
        discordUserId,
        `**BrawlClaim daily check**\n${formatPrivateStatus(profile, result)}`,
      );
    }),
  ).then((outcomes) => {
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to send ${failures.length} Discord notification(s).`,
      );
    }
  });
}
