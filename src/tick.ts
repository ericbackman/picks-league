// The idempotent tick + slate/grading logic. Runs from the cron trigger every
// 15 minutes: posts the
// day's slate after SLATE_HOUR ET (once), sweeps ungraded days for finals,
// edits game messages with results, and posts a recap when a day completes.
// All state lives in D1, so any single run can fail and the next catches up.

import {
  createDmChannel,
  createMessage,
  editMessage,
  pinMessage,
  sleep,
  type Env,
} from "./discord";
import { EMBED_COLOR } from "./brand";
import { DRAW_LEAGUES, LEAGUE_ICONS, LEAGUES, type GameInfo } from "./leagues";
import { sourceFor } from "./sources";
import { fairProbs, favoriteSide, fmtMl, fmtPct, payoutFor, type MlGame } from "./odds";
import {
  currentStreaks,
  fmtPoints,
  pointsFor,
  standings,
  standingsByLeague,
  type Standing,
  type Streak,
} from "./scoring";
import { Store, type GameRow, type GradedRow, type PickRow } from "./store";

export const BOOKIE_ID = "bookie"; // synthetic leaderboard player; real user ids are numeric snowflakes
export const BOOKIE_NAME = "The Bookie 🤖";

export const SLATE_HOUR = 6; // post the day's slate at/after 6:00 ET

// A metered source (The Odds API's free tier is a few hundred calls a month)
// grades on a schedule instead of every tick. 6 ET catches every game of the
// night before; add "23" for a same-evening sweep if your quota allows.
export const GRADE_HOURS_DEFAULT = "6";

// A game with no result this long after its start is voided: postponed,
// cancelled, or dropped by the source. Without this one lost game would hold a
// day open forever, and with it no recap ever posts.
export const VOID_AFTER_HOURS = 72;

// Gentle spacing between bulk game posts so a big slate stays under Discord's
// per-channel message rate limit (rest() still retries a 429 beneath us).
const POST_SPACING_MS = 300;

// Per-sport sections shown on BOTH the pinned standings board and the daily
// recap, in display order.
// THE SEAM: add a league here to give it its own board. The `league` must be a
// key in leagues.ts LEAGUES (so it has an icon). A league with no graded pick yet
// is omitted from the board, so listing a sport out of season costs nothing.
export const SPORT_BOARDS: { league: string; label: string }[] = [
  { league: "nba", label: "Basketball" },
  { league: "nhl", label: "Hockey" },
  { league: "mlb", label: "Baseball" },
  { league: "nfl", label: "Football" },
  { league: "wc", label: "World Cup" },
];

export interface SportBoard {
  label: string;
  icon: string;
  table: Standing[];
  bookiePoints?: number; // the Bookie's points in this league — the per-sport benchmark
}

/**
 * Per-sport SEASON standings for every league in SPORT_BOARDS, in display order,
 * each capped with the Bookie's points in that league. PURE — no I/O.
 *
 * The single source of truth for the sport split: the pinned board and the daily
 * recap both call this, so the two can never drift (the bug that hid the split
 * from the recap for weeks). Takes ALL graded rows — Bookie included — and
 * partitions humans/Bookie itself. Leagues with no graded human picks are
 * omitted (standingsByLeague drops them), so the split grows as sports come online.
 */
export function buildSportBoards(seasonRows: GradedRow[]): SportBoard[] {
  const humans = seasonRows.filter((r) => r.user_id !== BOOKIE_ID);
  const bookieRows = seasonRows.filter((r) => r.user_id === BOOKIE_ID);
  return standingsByLeague(
    humans,
    SPORT_BOARDS.map((b) => b.league)
  ).map(({ league, table }) => ({
    label: SPORT_BOARDS.find((b) => b.league === league)!.label,
    icon: LEAGUE_ICONS[league] ?? "",
    table,
    bookiePoints: standings(bookieRows.filter((r) => r.league === league))[0]?.points,
  }));
}
// What a fresh /picksetup posts when no leagues are given. A full MLB slate is
// 15 games a day; filter it to a team ("mlb:TOR") if that floods your channel.
export const DEFAULT_LEAGUES = "nba nhl mlb nfl";

// ---------- league specs ----------
// A leagues setting is whitespace-separated entries: "nba" takes the whole
// league, "mlb:TOR" filters to games involving those teams (multiple teams:
// "mlb:TOR+NYY" or "mlb:TOR,NYY").

export interface LeagueSpec {
  key: string;
  teams: Set<string> | null; // null = whole league
}

export function parseLeagueSpecs(raw: string): LeagueSpec[] {
  const specs: LeagueSpec[] = [];
  for (const entry of raw.trim().split(/\s+/)) {
    if (!entry) continue;
    const [key, teamPart] = entry.split(":", 2);
    const teams = teamPart
      ? new Set(
          teamPart
            .split(/[+,]/)
            .map((t) => t.trim().toUpperCase())
            .filter(Boolean)
        )
      : null;
    specs.push({ key: key.toLowerCase(), teams: teams?.size ? teams : null });
  }
  return specs;
}

export function unknownLeagues(specs: LeagueSpec[]): string[] {
  return specs.map((s) => s.key).filter((key) => !Object.hasOwn(LEAGUES, key));
}

// A team token matches an abbreviation exactly ("TOR") or any team whose name
// contains it ("JAYS", "BLUE JAYS"): sources differ in whether they have
// abbreviations at all.
export function filterGames(games: GameInfo[], spec: LeagueSpec): GameInfo[] {
  if (!spec.teams) return games;
  const matches = (abbr: string, name: string | undefined) =>
    [...spec.teams!].some((t) => abbr.toUpperCase() === t || (name ?? "").toUpperCase().includes(t));
  return games.filter((g) => matches(g.away, g.awayName) || matches(g.home, g.homeName));
}

/**
 * Whether this tick should grade, and the slot to record once it has. "*" grades
 * every tick and records nothing. A list of ET hours grades once per listed hour:
 * the slot `<day>T<hour>` is written after a successful sweep, so a sweep that
 * throws is retried on the next tick in the same hour and never silently skipped.
 */
export function gradeDue(
  gradeHours: string,
  day: string,
  hour: number,
  lastSlot: string | null
): { due: boolean; slot: string | null } {
  const spec = gradeHours.trim();
  if (spec === "*" || spec === "") return { due: true, slot: null };
  const hours = spec.split(/[\s,]+/).filter(Boolean).map(Number);
  if (hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
    throw new Error(`GRADE_HOURS must be "*" or ET hours 0-23 like "6 23", not ${JSON.stringify(gradeHours)}`);
  }
  if (!hours.includes(hour)) return { due: false, slot: null };
  const slot = `${day}T${String(hour).padStart(2, "0")}`;
  return slot === lastSlot ? { due: false, slot: null } : { due: true, slot };
}

// ---------- time helpers ----------
// Live in time.ts (pure, no Discord code). Re-exported here because index.ts
// and the tests import them from this module.
export { etParts, fmtEt, prettyDay, yyyymmdd } from "./time";
import { etParts, fmtEt, prettyDay, yyyymmdd } from "./time";

// ---------- message payloads ----------

// Soccer reads "Home vs Away"; North American sports read "Away @ Home".
export function matchupLabel(league: string, awayName: string, homeName: string): string {
  return DRAW_LEAGUES.has(league) ? `${homeName} vs ${awayName}` : `${awayName} @ ${homeName}`;
}

function toMlGame(game: GameInfo): MlGame {
  return {
    home_ml: game.homeMl,
    away_ml: game.awayMl,
    draw_ml: game.drawMl,
    odds: game.odds,
    away: game.away,
    home: game.home,
  };
}

// One side's odds three ways for the non-bettors: American line, fair win
// chance, and what a correct pick scores (see scoring.ts). Points, not money.
function sideOdds(label: string, ml: number | null, prob: number, payout: number): string {
  const american = ml !== null ? ` ${fmtMl(ml)}` : "";
  return `${label}${american} · ${fmtPct(prob)} · scores **${payout}**`;
}

export function gameLine(game: GameInfo): string {
  const matchup = matchupLabel(game.league, game.awayName, game.homeName);
  let line = `${LEAGUE_ICONS[game.league] ?? ""} **${matchup}** — ${fmtEt(game.startUtc)}`;
  const ml = toMlGame(game);
  const probs = fairProbs(ml);
  if (!probs) {
    if (game.odds) line += `  ·  \`${game.odds}\``;
    return line;
  }
  const part = (side: string, label: string, mlValue: number | null) =>
    sideOdds(label, mlValue, probs[side], payoutFor(side, ml));
  const parts = DRAW_LEAGUES.has(game.league)
    ? [
        part("home", game.home, game.homeMl),
        ...(probs.draw ? [part("draw", "Draw", game.drawMl)] : []),
        part("away", game.away, game.awayMl),
      ]
    : [part("away", game.away, game.awayMl), part("home", game.home, game.homeMl)];
  return `${line}\n📊 ${parts.join("  |  ")}`;
}

export function gameButtons(game: GameInfo): object[] {
  const away = { type: 2, style: 2, label: game.away, custom_id: `pick:${game.gameId}:away` };
  const home = { type: 2, style: 1, label: game.home, custom_id: `pick:${game.gameId}:home` };
  const buttons = DRAW_LEAGUES.has(game.league)
    ? [home, { type: 2, style: 2, label: "Draw", custom_id: `pick:${game.gameId}:draw` }, away]
    : [away, home];
  return [{ type: 1, components: buttons }]; // type 1 = action row
}

// A game card: one embed with the matchup line and the odds, buttons beneath.
// `extra` carries the crowd tally.
export function gameEmbeds(info: GameInfo, extra?: string): object[] {
  return [{ description: gameLine(info) + (extra ? `\n${extra}` : ""), color: EMBED_COLOR }];
}

// Rehydrate a stored row into the GameInfo shape so the slate renderers
// (gameLine/gameButtons) work for live message edits, not just fresh fetches.
function rowToGameInfo(g: GameRow): GameInfo {
  return {
    gameId: g.game_id,
    league: g.league,
    startUtc: g.start_utc,
    away: g.away,
    home: g.home,
    awayName: g.away_name,
    homeName: g.home_name,
    state: g.graded ? "post" : "pre",
    completed: g.graded === 1,
    awayScore: g.away_score,
    homeScore: g.home_score,
    winner: g.winner,
    odds: g.odds,
    homeMl: g.home_ml,
    awayMl: g.away_ml,
    drawMl: g.draw_ml,
  };
}

// ---------- personal pick card (ephemeral reply, /mypicks, and DM) ----------

/**
 * One player's selections for a day as an embed. Blank-until-picked is the
 * caller's job (an empty `rows` means "hasn't picked"); given rows, each line
 * shows the pick and its live status — locking soon, voided, hit (+pts), or miss.
 * Pure: same rows in, same embed out. Shared by the tap reply, /mypicks, and the
 * DM card so all three always agree.
 */
export function dayCardEmbed(rows: (PickRow & GameRow)[], day: string, title: string): object {
  const lines = rows.map((r) => {
    const team = r.side === "draw" ? "Draw 🤝" : r.side === "home" ? r.home_name : r.away_name;
    const icon = LEAGUE_ICONS[r.league] ?? "";
    let status: string;
    if (!r.graded) status = `⏳ locks ${fmtEt(r.start_utc)}`;
    else if (r.winner === "void") status = "🚫 voided";
    else if (r.side === r.winner) status = `✅ +${fmtPoints(r.points ?? 0)}`;
    else status = "❌";
    return `${icon} ${matchupLabel(r.league, r.away_name, r.home_name)} — **${team}** ${status}`;
  });
  return { title: `${title} — ${prettyDay(day)}`, description: lines.join("\n"), color: EMBED_COLOR };
}

// ---------- anonymous vote tally on the slate message ----------

// Crowd counts per side, excluding The Bookie (the house bot isn't "the crowd").
function tallyCounts(picks: PickRow[]): Record<string, number> {
  const counts: Record<string, number> = { home: 0, draw: 0, away: 0 };
  for (const p of picks) {
    if (p.user_id === BOOKIE_ID) continue;
    if (p.side in counts) counts[p.side] += 1;
  }
  return counts;
}

function tallyLine(game: GameRow, picks: PickRow[]): string {
  const c = tallyCounts(picks);
  if (c.home + c.draw + c.away === 0) return ""; // nobody yet — no tally line at all
  const parts = DRAW_LEAGUES.has(game.league)
    ? [`${game.home} ${c.home}`, `Draw ${c.draw}`, `${game.away} ${c.away}`]
    : [`${game.away} ${c.away}`, `${game.home} ${c.home}`];
  return `📊 ${parts.join(" · ")}`;
}

/**
 * Repaint a still-open game's slate message with the current crowd tally,
 * preserving its pick buttons. No-ops once the game has started or graded — a
 * locked message is left exactly as grading left it.
 */
export async function refreshGameTally(env: Env, store: Store, gameId: string): Promise<void> {
  const channelId = await store.getSetting("channel_id");
  if (!channelId) return;
  const game = await store.game(gameId);
  if (!game || !game.message_id || game.graded) return;
  const start = new Date(game.start_utc);
  if (!isNaN(start.getTime()) && Date.now() >= start.getTime()) return;
  const info = rowToGameInfo(game);
  const tally = tallyLine(game, await store.picksForGame(gameId));
  try {
    await editMessage(env, channelId, game.message_id, {
      // content:"" clears any text above the card.
      content: "",
      embeds: gameEmbeds(info, tally || undefined),
      components: gameButtons(info),
    });
  } catch (err) {
    console.warn(`couldn't refresh tally for game ${gameId}:`, err);
  }
}

// ---------- DM pick card (always-on, edited in place) ----------

/**
 * Create or update the user's private DM pick card for the day. First pick of
 * the day opens the DM and posts the card; later taps edit that same message, so
 * the player always has a live private view. Swallows errors — a user with DMs
 * closed simply doesn't get one, and the ephemeral card still covers them.
 */
export async function syncDmCard(env: Env, store: Store, userId: string, day: string): Promise<void> {
  const rows = await store.picksForUserDay(userId, day);
  if (!rows.length) return;
  const embed = dayCardEmbed(rows, day, "🎟️ Your picks");

  // Card already exists for today — just edit it in place (no new message).
  const existing = await store.getDmCard(userId, day);
  if (existing?.message_id) {
    try {
      await editMessage(env, existing.dm_channel_id, existing.message_id, { embeds: [embed] });
    } catch (err) {
      console.warn("DM card edit failed:", err);
    }
    return;
  }

  // First card of the day. Opening a DM channel sends nothing, so it's safe to
  // repeat; the claim then guarantees exactly ONE tap posts the message.
  let dmChannel: string;
  try {
    dmChannel = await createDmChannel(env, userId);
  } catch (err) {
    console.warn("couldn't open a DM (closed DMs?):", err);
    return;
  }
  if (!(await store.claimDmCard(userId, day, dmChannel))) {
    // A concurrent tap won the claim — edit its card if ready, but never post a
    // second DM. (If it's not ready yet, the next tap or grading edit catches up.)
    const now = await store.getDmCard(userId, day);
    if (now?.message_id) {
      try {
        await editMessage(env, now.dm_channel_id, now.message_id, { embeds: [embed] });
      } catch (err) {
        console.warn("DM card edit (post-claim) failed:", err);
      }
    }
    return;
  }
  try {
    const messageId = await createMessage(env, dmChannel, { embeds: [embed] });
    await store.finalizeDmCard(userId, day, messageId);
  } catch (err) {
    // DMs closed / send blocked: release the claim so we're not stuck, and stop —
    // nothing was delivered, so there's nothing to spam.
    await store.clearDmCard(userId, day);
    console.warn("DM card create failed (DMs closed?):", err);
  }
}

// When a day finishes, repaint every DM card so it shows results, not lock times.
async function refreshDmCardsForDay(env: Env, store: Store, day: string): Promise<void> {
  for (const card of await store.dmCardsForDay(day)) {
    const rows = await store.picksForUserDay(card.user_id, day);
    if (!rows.length) continue;
    try {
      await editMessage(env, card.dm_channel_id, card.message_id, {
        embeds: [dayCardEmbed(rows, day, "🎟️ Your picks")],
      });
    } catch (err) {
      console.warn("couldn't refresh a DM card:", err);
    }
  }
}

// ---------- pinned live leaderboard ----------

// Rank marker for the i-th (0-based) row: 🥇🥈🥉 then `4.`, `5.`, … Shared by
// every ranked column so medals stay consistent across the whole bot.
function medal(i: number): string {
  return ["🥇", "🥈", "🥉"][i] ?? `\`${i + 1}.\``;
}

// One embed field for a per-sport season board: medaled top-5 on points, capped
// with the league's Bookie benchmark. PURE. Shared by the pinned board and the
// daily recap — this is what keeps the two sport splits rendering identically.
export function sportBoardField(b: SportBoard): { name: string; value: string; inline: boolean } {
  let value =
    b.table
      .slice(0, 5)
      .map((e, i) => `${medal(i)} ${e.name} ${fmtPoints(e.points)} pts`)
      .join("\n") || "—";
  if (b.bookiePoints !== undefined) value += `\n*🤖 ${fmtPoints(b.bookiePoints)} to beat*`;
  return { name: `${b.icon} ${b.label}`.trim(), value, inline: true };
}

// The overall "split" — Today | Season | Hot streak — followed by one season
// field per sport (World Cup, Baseball, …). Everything here is humans only; the
// Bookie shows as a footer benchmark, never as a ranked row — you beat it, you
// don't share a board with it.
function leaderboardEmbed(
  today: Standing[],
  season: Standing[],
  streaks: Streak[],
  gamesLeft: number,
  bookie: Standing | undefined,
  sportBoards: SportBoard[]
): object {
  const col = (rows: Standing[], suffix: (e: Standing) => string) =>
    rows
      .slice(0, 5)
      .map((e, i) => `${medal(i)} ${e.name} ${suffix(e)}`)
      .join("\n") || "—";
  const streakCol =
    streaks
      .slice(0, 5)
      .map((s) => `${s.name} 🔥${s.streak}`)
      .join("\n") || "—";
  const bench = bookie ? `🤖 The Bookie: ${fmtPoints(bookie.points)} pts — beat it` : "";
  const left = gamesLeft > 0 ? `${gamesLeft} game(s) left today` : "updated after each final";
  const fields = [
    { name: "Today", value: col(today, (e) => `**+${fmtPoints(e.points)}**`), inline: true },
    { name: "Season", value: col(season, (e) => `${fmtPoints(e.points)} pts`), inline: true },
    { name: "🔥 Hot streak", value: streakCol, inline: true },
    // Per-sport season boards — same medals + points as the overall Season
    // column, each capped with the Bookie's score in that league.
    ...sportBoards.map(sportBoardField),
  ];
  return {
    title: "🏆 Standings",
    color: EMBED_COLOR,
    fields,
    footer: { text: bench ? `${bench} · ${left}` : left },
  };
}

/**
 * Keep one pinned standings message current. Creates + pins it on first grading,
 * edits it in place thereafter. Self-healing: if the edit fails (message deleted)
 * it reposts and re-pins.
 */
export async function updateLeaderboard(env: Env, store: Store, channelId: string): Promise<boolean> {
  const seasonRows = await store.gradedRows();
  if (!seasonRows.length) return false; // nothing graded yet — no board to show
  const humans = (rows: GradedRow[]) => rows.filter((r) => r.user_id !== BOOKIE_ID);
  const { day } = etParts(new Date());
  const season = standings(humans(seasonRows));
  const today = standings(humans(await store.gradedRows(day)));
  const streaks = currentStreaks(await store.gradedRowsChrono()).filter((s) => s.user_id !== BOOKIE_ID);
  const bookie = standings(seasonRows.filter((r) => r.user_id === BOOKIE_ID))[0];
  const sportBoards = buildSportBoards(seasonRows);
  const embed = leaderboardEmbed(today, season, streaks, await store.countUngraded(day), bookie, sportBoards);
  const existing = await store.getSetting("leaderboard_message_id");
  if (existing) {
    try {
      await editMessage(env, channelId, existing, { embeds: [embed] });
      return true;
    } catch (err) {
      console.warn("leaderboard edit failed, reposting:", err);
    }
  }
  const messageId = await createMessage(env, channelId, { embeds: [embed] });
  await store.setSetting("leaderboard_message_id", messageId);
  try {
    await pinMessage(env, channelId, messageId);
  } catch (err) {
    console.warn("couldn't pin leaderboard:", err);
  }
  return true;
}

// ---------- slate posting ----------

/**
 * Post the day's games — idempotent top-up: games already posted (a stored
 * message_id) are skipped, so re-running after a mid-day /picksetup change
 * posts only what's new. Returns how many game messages were posted.
 */
export async function postSlate(env: Env, store: Store, channelId: string, day: string): Promise<number> {
  const source = sourceFor(env);
  const specs = parseLeagueSpecs((await store.getSetting("leagues")) ?? DEFAULT_LEAGUES);
  const byId = new Map<string, GameInfo>(); // dedupe: "mlb:TOR mlb:STL" fetches mlb twice
  const fetched = new Map<string, GameInfo[]>(); // one call per league, even with several specs
  for (const spec of specs) {
    try {
      if (!fetched.has(spec.key)) fetched.set(spec.key, await source.slate(spec.key, day));
      for (const game of filterGames(fetched.get(spec.key)!, spec)) {
        byId.set(game.gameId, game);
      }
    } catch (err) {
      console.error(`fetching ${spec.key} slate for ${day} from ${source.name}:`, err);
    }
  }
  const games = [...byId.values()];
  if (!games.length) {
    // Mark empty days handled — don't re-ask the source all day.
    await store.setSetting("last_slate_day", day);
    console.log(`no games on ${day}`);
    return 0;
  }
  const posted = new Set(
    (await store.gamesForDay(day)).filter((g) => g.message_id).map((g) => g.game_id)
  );
  await store.upsertGames(day, games);
  const fresh = games.filter((g) => !posted.has(g.gameId));
  if (!fresh.length) {
    await store.setSetting("last_slate_day", day);
    return 0;
  }
  // The Bookie rides every favorite, no exceptions. Beat it.
  for (const game of fresh) {
    if (game.state !== "pre") continue;
    const fav = favoriteSide(toMlGame(game));
    if (fav) await store.recordPick(game.gameId, BOOKIE_ID, BOOKIE_NAME, fav);
  }
  // Header once per day; a later top-up (mid-day /picksetup change, or a
  // rate-limited first pass) says "added" instead of re-posting the intro.
  if ((await store.getSetting(`intro_${day}`)) !== "1") {
    try {
      await createMessage(env, channelId, {
        embeds: [
          {
            title: `🏟️ Picks — ${prettyDay(day)}`,
            description:
              `**${fresh.length}** games today. Tap a team to call the winner — ` +
              "change your mind anytime until the game starts.\n" +
              "Correct picks **score their odds**: chalk scores a little, dogs score a lot. " +
              "Points only: no money, no prizes. " +
              `${BOOKIE_NAME} picks every favorite — beat it or be it. ` +
              "`/leaderboard` for standings. Taps record your Discord name for the " +
              "standings; `/forgetme` erases them.",
            color: EMBED_COLOR,
          },
        ],
      });
      await store.setSetting(`intro_${day}`, "1");
    } catch (err) {
      console.warn("couldn't post slate header:", err);
    }
  } else {
    try {
      await createMessage(env, channelId, { content: "➕ **Added to today's board:**" });
    } catch (err) {
      console.warn("couldn't post top-up note:", err);
    }
  }
  fresh.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  // Post each game as its own card. Per-game try/catch + pacing so one
  // rate-limited post can't abort the rest; rest() already retries 429s beneath us.
  let postedCount = 0;
  for (const game of fresh) {
    const payload =
      game.state === "pre"
        ? { embeds: gameEmbeds(game), components: gameButtons(game) }
        : {
            // Already underway when first seen — no pick to make, so just the
            // compact line (grading will overwrite it with the final).
            embeds: [
              { description: gameLine(game) + "  ·  🔒 already started", color: EMBED_COLOR },
            ],
          };
    try {
      const messageId = await createMessage(env, channelId, payload);
      await store.setMessage(game.gameId, messageId);
      postedCount++;
      await sleep(POST_SPACING_MS);
    } catch (err) {
      console.warn(`couldn't post game ${game.gameId} (will top up next tick):`, err);
    }
  }
  // Flag the day slated only once no game is missing its message — a partial pass
  // (rate limit, transient error) leaves it unset so the next cron tick tops up
  // the rest automatically instead of the slate silently staying incomplete.
  if (!(await store.gamesForDay(day)).some((g) => !g.message_id)) {
    await store.setSetting("last_slate_day", day);
  }
  return postedCount;
}

// ---------- grading ----------

export async function gradePending(env: Env, store: Store, channelId: string): Promise<void> {
  const source = sourceFor(env);
  let gradedAny = false;
  const visited = new Set<string>();
  for (const day of await store.daysWithUngraded()) {
    visited.add(day);
    for (const league of await store.ungradedLeagues(day, new Date().toISOString())) {
      let infos: GameInfo[];
      try {
        infos = await source.results(league, day);
      } catch (err) {
        console.error(`grading fetch ${league} ${day} from ${source.name}:`, err);
        continue;
      }
      for (const info of infos) {
        if (info.completed) await store.applyResult(info);
      }
    }
    const voided = await store.voidStale(day, new Date(Date.now() - VOID_AFTER_HOURS * 3_600_000).toISOString());
    if (voided) console.warn(`${voided} game(s) on ${day} had no result after ${VOID_AFTER_HOURS}h: voided`);
    for (const game of await store.ungradedFinals(day)) {
      const picks = await store.picksForGame(game.game_id);
      const points = new Map<string, number>(
        picks.map((p) => [p.user_id, p.side === game.winner ? pointsFor(p.side, game) : 0])
      );
      await store.gradeGame(game.game_id, points);
      await editFinalMessage(env, channelId, game, picks);
      gradedAny = true;
    }
    await maybeRecap(env, store, channelId, day);
  }

  // A day whose recap failed to post is fully graded, so the loop above will never
  // see it again — it is driven by what is UNgraded. Sweep the recently finished
  // days so a missed recap is retried instead of lost for good.
  for (const day of await store.daysFullyGraded()) {
    if (!visited.has(day)) await maybeRecap(env, store, channelId, day);
  }
  // Standings only move when something graded — refresh the pinned board once.
  if (gradedAny) await updateLeaderboard(env, store, channelId);
}

async function editFinalMessage(env: Env, channelId: string, game: GameRow, picks: PickRow[]): Promise<void> {
  if (!game.message_id) return;
  const icon = LEAGUE_ICONS[game.league] ?? "";
  const soccer = DRAW_LEAGUES.has(game.league);
  let line: string;
  if (game.winner === "void") {
    const matchup = matchupLabel(game.league, game.away_name, game.home_name);
    line = `${icon} ~~${matchup}~~ — 🚫 no contest, picks voided`;
  } else {
    line = soccer
      ? `${icon} **Final:** ${game.home_name} ${game.home_score} — ${game.away_name} ${game.away_score}`
      : `${icon} **Final:** ${game.away_name} ${game.away_score} — ${game.home_name} ${game.home_score}`;
    if (game.winner === "draw") line += " 🤝";
    const callers = picks.filter((p) => p.side === game.winner).map((p) => p.user_name);
    line += callers.length ? `\n🎯 ${callers.join(", ")}` : "\n🎯 nobody saw it coming";
  }
  // Replace the card (and clear the now-dead buttons) with a compact text
  // final: results are permanent channel history.
  try {
    await editMessage(env, channelId, game.message_id, {
      content: "",
      embeds: [{ description: line, color: EMBED_COLOR }],
      components: [],
    });
  } catch (err) {
    console.warn(`couldn't edit final message for game ${game.game_id}:`, err);
  }
}

/**
 * Post a day's recap exactly once, when nothing is left ungraded.
 *
 * The post is isolated so a Discord failure does not abort the whole grading tick,
 * and the flag is only set once the recap is actually out — otherwise the day
 * would be marked done while its recap never appeared.
 */
async function maybeRecap(env: Env, store: Store, channelId: string, day: string): Promise<void> {
  if ((await store.countUngraded(day)) !== 0) return;
  if ((await store.getSetting(`recap_${day}`)) === "1") return;
  try {
    await postRecap(env, store, channelId, day);
    await refreshDmCardsForDay(env, store, day); // flip DM cards from lock times to results
  } catch (err) {
    // Leave the flag unset so the next tick retries rather than losing the recap.
    console.error(`recap ${day} failed; will retry next tick:`, err);
    return;
  }
  await store.setSetting(`recap_${day}`, "1");
}

async function postRecap(env: Env, store: Store, channelId: string, day: string): Promise<void> {
  const humans = (rows: GradedRow[]) => rows.filter((r) => r.user_id !== BOOKIE_ID);
  const today = standings(humans(await store.gradedRows(day)));
  if (!today.length) return; // nobody (human) picked — skip the ceremony
  const seasonRows = await store.gradedRows();
  const season = standings(humans(seasonRows));
  const lines = today
    .slice(0, 10)
    .map((e) => `**${e.name}** +${fmtPoints(e.points)} (${e.wins}-${e.losses})`);
  await createMessage(env, channelId, {
    embeds: [
      {
        title: `📊 Results — ${prettyDay(day)}`,
        description: lines.join("\n"),
        color: EMBED_COLOR,
        fields: [
          {
            name: "Season",
            value: season
              .slice(0, 10)
              .map(
                (e, i) =>
                  `\`${i + 1}.\` **${e.name}** — ${fmtPoints(e.points)} pts (${e.wins}-${e.losses})`
              )
              .join("\n"),
            inline: false,
          },
          // The same per-sport season split the pinned board shows, so the
          // once-a-day recap tells the full story — not just the combined table.
          // (Before this, the split lived only on the easy-to-miss pinned board.)
          ...buildSportBoards(seasonRows).map(sportBoardField),
        ],
      },
    ],
  });
}

// ---------- the tick ----------

export async function runTick(env: Env): Promise<void> {
  const store = new Store(env.DB);
  const channelId = await store.getSetting("channel_id");
  if (!channelId) return; // /picksetup hasn't run yet
  const { day, hour } = etParts(new Date());
  const last = await store.getSetting("last_slate_day");
  if (last !== day && hour >= SLATE_HOUR) {
    await postSlate(env, store, channelId, day);
  }
  const source = sourceFor(env);
  const gradeHours = env.GRADE_HOURS ?? (source.quotaBound ? GRADE_HOURS_DEFAULT : "*");
  const { due, slot } = gradeDue(gradeHours, day, hour, await store.getSetting("last_grade_slot"));
  if (!due) return;
  await gradePending(env, store, channelId);
  if (slot) await store.setSetting("last_grade_slot", slot);
}
