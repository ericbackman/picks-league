// Register the bot's slash commands (guild-scoped: instant, single-server).
// Reads DISCORD_TOKEN / DISCORD_APPLICATION_ID / GUILD_ID from the
// environment or from .dev.vars (wrangler's gitignored local secrets file).
//
// Run: npm run register

import { readFileSync } from "node:fs";

function loadDevVars() {
  try {
    const text = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^([A-Z_]+)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  } catch {
    // no .dev.vars — env vars only
  }
}

loadDevVars();
const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APPLICATION_ID || !GUILD_ID) {
  console.error(
    "Missing DISCORD_TOKEN, DISCORD_APPLICATION_ID, or GUILD_ID.\n" +
      "Put them in .dev.vars (see README) or set them in the environment."
  );
  process.exit(1);
}

const MANAGE_GUILD = "32";

const commands = [
  {
    name: "picksetup",
    description: "Set the picks channel (and which leagues count)",
    default_member_permissions: MANAGE_GUILD,
    options: [
      {
        type: 7, // CHANNEL
        name: "channel",
        description: "Channel where daily slates post",
        required: true,
        channel_types: [0], // text channels
      },
      {
        type: 3, // STRING
        name: "leagues",
        description: "e.g. nba nhl mlb:jays — leagues, or league:TEAM to filter by name (default: nba nhl mlb nfl)",
        required: false,
      },
    ],
  },
  // Manage Server: a slate fetch spends the operator's data credits.
  { name: "slate", description: "Post today's games now", default_member_permissions: MANAGE_GUILD },
  { name: "leaderboard", description: "Season standings" },
  { name: "mypicks", description: "Your picks for today (only you see this)" },
  { name: "forgetme", description: "Delete your picks, tap history and DM cards here (asks you to confirm)" },
];

const resp = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${GUILD_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  }
);

if (!resp.ok) {
  console.error(`Registration failed: HTTP ${resp.status}`, await resp.text());
  process.exit(1);
}
const registered = await resp.json();
console.log(`Registered ${registered.length} commands: ${registered.map((c) => "/" + c.name).join(", ")}`);
