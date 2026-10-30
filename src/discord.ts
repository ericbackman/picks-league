// Discord plumbing: request signature verification (Ed25519 via WebCrypto) and the
// few REST calls the bot makes. No SDK — the surface is tiny.
//
// Deliberately carries NO branding: the embed colour lives in `brand.ts`, so this
// file can be dropped into another bot unchanged.

export interface Env {
  DB: D1Database;
  DISCORD_TOKEN: string; // secret: npx wrangler secret put DISCORD_TOKEN
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  GUILD_ID: string;
  // Optional secret for an external scheduler that POSTs /tick instead of (or as
  // well as) the cron trigger. Optional in the type so the bot typechecks before
  // it is set, but the route fails CLOSED while it is missing (see tickroute.ts).
  TICK_KEY?: string;
  // Optional var: "off" posts game cards without the ESPN team logos (README,
  // "Team logos"). Anything else, or unset, shows them.
  TEAM_LOGOS?: string;
}

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  UPDATE_MESSAGE: 7, // edit the message the button sits on
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
} as const;

export const EPHEMERAL = 64;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordRequest(
  publicKeyHex: string,
  signature: string | null,
  timestamp: string | null,
  body: string
): Promise<boolean> {
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body)
    );
  } catch {
    return false;
  }
}

// ---------- REST ----------

const API = "https://discord.com/api/v10";
const MAX_REST_ATTEMPTS = 4;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// One Discord REST call, resilient to transient failure. Discord rate-limits
// per channel, so posting a big slate in a burst trips a 429 and, without this,
// the first one aborts the whole posting loop mid-slate. On a 429 we wait exactly as long as Discord tells us
// (`retry_after`) and try again; 5xx get an exponential backoff.
async function rest(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  attempt = 0
): Promise<any> {
  const resp = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (resp.ok) return resp.status === 204 ? null : resp.json();

  const retryable = resp.status === 429 || (resp.status >= 500 && resp.status < 600);
  if (retryable && attempt < MAX_REST_ATTEMPTS) {
    let waitMs: number;
    if (resp.status === 429) {
      // Discord reports the wait in the body (`retry_after`, seconds) and header.
      const text = await resp.text();
      let retryAfter = 1;
      try {
        retryAfter = JSON.parse(text).retry_after ?? retryAfter;
      } catch {
        /* non-JSON body — fall back to the header/default below */
      }
      const header = resp.headers.get("Retry-After");
      if (header) retryAfter = Math.max(retryAfter, Number(header));
      waitMs = Math.ceil(retryAfter * 1000) + 100; // small cushion past the window
    } else {
      waitMs = 400 * 2 ** attempt; // 0.4s, 0.8s, 1.6s …
    }
    await sleep(waitMs);
    return rest(env, method, path, body, attempt + 1);
  }
  throw new Error(
    `Discord ${method} ${path}: HTTP ${resp.status} ${await resp.text().catch(() => "")}`
  );
}

/** Post a message; returns its id. */
export async function createMessage(env: Env, channelId: string, payload: object): Promise<string> {
  const message = await rest(env, "POST", `/channels/${channelId}/messages`, payload);
  return String(message.id);
}

export async function editMessage(
  env: Env,
  channelId: string,
  messageId: string,
  payload: object
): Promise<void> {
  await rest(env, "PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
}

/** Open (or fetch the existing) DM channel with a user; returns its channel id. */
export async function createDmChannel(env: Env, recipientId: string): Promise<string> {
  const channel = await rest(env, "POST", "/users/@me/channels", { recipient_id: recipientId });
  return String(channel.id);
}

/** Pin a message so it sits in the channel's pin list — used for the live leaderboard. */
export async function pinMessage(env: Env, channelId: string, messageId: string): Promise<void> {
  await rest(env, "PUT", `/channels/${channelId}/pins/${messageId}`);
}

/** Replace the deferred "thinking…" response of an interaction. */
export async function editOriginalResponse(
  env: Env,
  interactionToken: string,
  payload: object
): Promise<void> {
  // Webhook-style endpoint — authenticated by the interaction token, no Bot header needed,
  // but sending it is harmless.
  await rest(
    env,
    "PATCH",
    `/webhooks/${env.DISCORD_APPLICATION_ID}/${interactionToken}/messages/@original`,
    payload
  );
}

// ---------- helpers for interaction payloads ----------

export function displayName(interaction: any): string {
  const member = interaction.member ?? {};
  const user = member.user ?? interaction.user ?? {};
  return member.nick ?? user.global_name ?? user.username ?? "someone";
}

export function userId(interaction: any): string {
  return String(interaction.member?.user?.id ?? interaction.user?.id ?? "0");
}

export function option(interaction: any, name: string): any {
  return interaction.data?.options?.find((o: any) => o.name === name)?.value;
}

/** Selected value(s) of a string-select interaction. Empty for non-select payloads. */
export function selectValues(interaction: any): string[] {
  const values = interaction.data?.values;
  return Array.isArray(values) ? values.map(String) : [];
}
