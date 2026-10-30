// picks — a serverless Discord picks league on Cloudflare Workers + D1.
//
// No gateway, no process: Discord delivers slash commands and button taps as
// signed HTTP POSTs to /interactions, and a cron trigger drives the daily
// slate + grading (see tick.ts).

import {
  deleteMessage,
  displayName,
  EPHEMERAL,
  editOriginalResponse,
  InteractionType,
  option,
  ResponseType,
  userId,
  verifyDiscordRequest,
  type Env,
} from "./discord";
import { LEAGUES } from "./espn";
import { Store } from "./store";
import {
  dayCardEmbed,
  DEFAULT_LEAGUES,
  etParts,
  parseLeagueSpecs,
  postSlate,
  refreshGameTally,
  runTick,
  SLATE_HOUR,
  syncDmCard,
  unknownLeagues,
  updateLeaderboard,
} from "./tick";
import { handleTickRoute } from "./tickroute";

function json(payload: object): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
}

function reply(content: string, ephemeral = true): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { content, flags: ephemeral ? EPHEMERAL : 0 },
  });
}

function replyEmbed(embed: object, ephemeral = false): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { embeds: [embed], flags: ephemeral ? EPHEMERAL : 0 },
  });
}

// ---------- button taps ----------

async function handlePick(
  env: Env,
  store: Store,
  interaction: any,
  ctx: ExecutionContext
): Promise<Response> {
  const [, gameId, side] = String(interaction.data?.custom_id ?? "").split(":");
  const game = await store.game(gameId);
  if (!game || !["home", "away", "draw"].includes(side)) {
    return reply("I don't know that game anymore 🤔");
  }
  const start = new Date(game.start_utc);
  if (game.graded || isNaN(start.getTime()) || Date.now() >= start.getTime()) {
    return reply("🔒 That game already started — picks are locked.");
  }
  const uid = userId(interaction);
  await store.recordPick(gameId, uid, displayName(interaction), side);
  const { day } = etParts(new Date());
  // Keep the DM card and the public crowd tally in sync in the background — both
  // are extra Discord round-trips we mustn't make the user wait on (3s deadline).
  ctx.waitUntil(syncDmCard(env, store, uid, day));
  ctx.waitUntil(refreshGameTally(env, store, gameId));
  // Reply instantly with the live personal card — their full day, latest pick included.
  const rows = await store.picksForUserDay(uid, day);
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: { content: "✅ Saved!", embeds: [dayCardEmbed(rows, day, "🎟️ Your picks")], flags: EPHEMERAL },
  });
}

// ---------- slash commands ----------

async function handlePicksetup(store: Store, interaction: any): Promise<Response> {
  const channelId = String(option(interaction, "channel"));
  const rawLeagues = (option(interaction, "leagues") as string | undefined)?.trim();
  if (rawLeagues) {
    const specs = parseLeagueSpecs(rawLeagues);
    const unknown = unknownLeagues(specs);
    if (unknown.length) {
      return reply(
        `Unknown league(s): ${unknown.join(", ")} — I know ${Object.keys(LEAGUES).join(", ")} ` +
          "(filter a league to teams like `mlb:TOR`)."
      );
    }
    await store.setSetting(
      "leagues",
      specs.map((s) => (s.teams ? `${s.key}:${[...s.teams].join("+")}` : s.key)).join(" ")
    );
  }
  await store.setSetting("channel_id", channelId);
  const active = ((await store.getSetting("leagues")) ?? DEFAULT_LEAGUES).replaceAll(" ", ", ");
  return reply(
    `🏟️ Picks live in <#${channelId}> covering **${active}**. ` +
      `Slates post daily after ${SLATE_HOUR}:00 ET — \`/slate\` posts today's now.`,
    false
  );
}

async function handleSlate(env: Env, store: Store, interaction: any, ctx: ExecutionContext): Promise<Response> {
  const channelId = await store.getSetting("channel_id");
  if (!channelId) {
    return reply("Picks aren't set up — `/picksetup` first.");
  }
  const { day } = etParts(new Date());
  // Posting 15+ messages blows the 3-second interaction deadline: defer, then
  // finish in the background and edit the deferred response. postSlate is an
  // idempotent top-up, so re-running just posts whatever's missing.
  ctx.waitUntil(
    (async () => {
      let text: string;
      try {
        const count = await postSlate(env, store, channelId, day);
        text = count
          ? `🏟️ **${count}** game(s) posted in <#${channelId}>.`
          : "✅ The board already shows every game for today's leagues — nothing new to add.";
      } catch (err) {
        console.error("slate failed:", err);
        text = "⚠️ Something broke posting the slate — check the worker logs.";
      }
      await editOriginalResponse(env, interaction.token, { content: text }).catch((err) =>
        console.error("slate reply failed:", err)
      );
    })()
  );
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

// /leaderboard is the on-demand trigger for the single pinned board: it
// creates + pins it the first time, refreshes it in place after. Pinning can
// blow the 3s deadline, so defer and finish in the background.
async function handleLeaderboard(
  env: Env,
  store: Store,
  interaction: any,
  ctx: ExecutionContext
): Promise<Response> {
  const channelId = await store.getSetting("channel_id");
  if (!channelId) {
    return reply("Picks aren't set up — `/picksetup` first.");
  }
  ctx.waitUntil(
    (async () => {
      let text: string;
      try {
        const posted = await updateLeaderboard(env, store, channelId);
        text = posted
          ? "📌 Standings pinned up top — refreshed."
          : "No graded picks yet — standings appear after the first finals.";
      } catch (err) {
        console.error("leaderboard refresh failed:", err);
        text = "⚠️ Couldn't refresh the standings — check the worker logs.";
      }
      await editOriginalResponse(env, interaction.token, { content: text }).catch((err) =>
        console.error("leaderboard reply failed:", err)
      );
    })()
  );
  return json({ type: ResponseType.DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

async function handleMypicks(store: Store, interaction: any): Promise<Response> {
  const { day } = etParts(new Date());
  const rows = await store.picksForUserDay(userId(interaction), day);
  if (!rows.length) {
    return reply("You haven't picked today — find the slate and tap some buttons!");
  }
  return replyEmbed(dayCardEmbed(rows, day, "🎟️ Your picks"), true); // only you see your card
}

// ---------- /forgetme ----------
// Deletes everything the bot stores about the requesting user: their picks,
// every tap in the audit log, and their DM cards (the rows AND the messages in
// their DMs). What it cannot reach, and the prompt says so: names already written
// into finished game cards and past recaps in the channel. Two steps so a mis-tap
// cannot wipe a season: the command shows a confirm button, the button does the work.

function handleForgetme(): Response {
  return json({
    type: ResponseType.CHANNEL_MESSAGE,
    data: {
      content:
        "This deletes **every pick you have ever made here**, your tap history and the " +
        "pick cards in your DMs, and drops you from the standings. Your name stays on " +
        "finished game cards and past recaps already posted in the channel. It cannot be undone.",
      flags: EPHEMERAL,
      components: [
        {
          type: 1, // action row
          components: [{ type: 2, style: 4, label: "Delete everything about me", custom_id: "forget:confirm" }],
        },
      ],
    },
  });
}

async function handleForgetConfirm(
  env: Env,
  store: Store,
  interaction: any,
  ctx: ExecutionContext
): Promise<Response> {
  const uid = userId(interaction);
  // The DM messages first, while the rows that locate them still exist. A card
  // that cannot be deleted (DMs since closed) is logged, not fatal.
  for (const card of await store.dmCardsForUser(uid)) {
    try {
      await deleteMessage(env, card.dm_channel_id, card.message_id);
    } catch (err) {
      console.warn("couldn't delete a DM card during /forgetme:", err);
    }
  }
  const removed = await store.forgetUser(uid);
  // The pinned standings still show them until the next refresh; do it now.
  const channelId = await store.getSetting("channel_id");
  if (channelId) {
    ctx.waitUntil(
      updateLeaderboard(env, store, channelId).catch((err) => console.error("leaderboard refresh after forget:", err))
    );
  }
  return json({
    type: ResponseType.UPDATE_MESSAGE,
    data: {
      content: `🗑️ Done. ${removed} pick(s) and your whole tap history are gone.`,
      components: [],
    },
  });
}

// ---------- worker entry points ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Optional external scheduler (inert until TICK_KEY is set, see tickroute.ts).
    // Must come BEFORE the catch-all below, which answers 200 to everything.
    const tick = handleTickRoute(request, url, env.TICK_KEY, () => runTick(env), ctx);
    if (tick) return tick;
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("🏟️ picks bot is alive", { status: 200 });
    }
    const body = await request.text();
    const valid = await verifyDiscordRequest(
      env.DISCORD_PUBLIC_KEY,
      request.headers.get("X-Signature-Ed25519"),
      request.headers.get("X-Signature-Timestamp"),
      body
    );
    if (!valid) return new Response("bad request signature", { status: 401 });

    const interaction = JSON.parse(body);
    if (interaction.type === InteractionType.PING) {
      return json({ type: ResponseType.PONG });
    }
    // Single-server by design: ignore anything from elsewhere.
    if (env.GUILD_ID && interaction.guild_id !== env.GUILD_ID) {
      return reply("This bot only serves its home server.");
    }

    const store = new Store(env.DB);
    try {
      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        const customId = String(interaction.data?.custom_id ?? "");
        if (customId.startsWith("pick:")) {
          return await handlePick(env, store, interaction, ctx);
        }
        if (customId === "forget:confirm") {
          return await handleForgetConfirm(env, store, interaction, ctx);
        }
        return reply("I don't know that button 🤔");
      }
      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        switch (interaction.data?.name) {
          case "picksetup":
            return await handlePicksetup(store, interaction);
          case "slate":
            return await handleSlate(env, store, interaction, ctx);
          case "leaderboard":
            return await handleLeaderboard(env, store, interaction, ctx);
          case "mypicks":
            return await handleMypicks(store, interaction);
          case "forgetme":
            return handleForgetme();
        }
      }
      return reply("Unknown interaction 🤔");
    } catch (err) {
      console.error("interaction failed:", err);
      return reply("⚠️ Something broke on my end — check the worker logs.");
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runTick(env));
  },
};
