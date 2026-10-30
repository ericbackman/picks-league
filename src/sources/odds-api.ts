// The Odds API (the-odds-api.com) as a SportSource: the default. Its terms allow
// storing the data and showing it in an app; the free Starter plan is 500 credits
// a month. What this file spends, per league:
//   slate()    1 credit  (one h2h market from one bookmaker group, cost 0 if no games)
//   results()  2 credits (the scores endpoint with daysFrom)
// so the default GRADE_HOURS ("6", one sweep a day) with all four leagues in
// season is at most 12 credits a day, about 360 a month. Every response carries
// x-requests-remaining and this file logs it, so running low is visible before
// it is a failure.

import { DRAW_LEAGUES, type GameInfo } from "../espn";
import { etDayBoundsUtc, etParts, shiftDay } from "../time";
import type { SportSource } from "./index";

export const ODDS_API_SPORTS: Record<string, string> = {
  nba: "basketball_nba",
  nhl: "icehockey_nhl",
  mlb: "baseball_mlb",
  nfl: "americanfootball_nfl",
  wc: "soccer_fifa_world_cup",
};

const API = "https://api.the-odds-api.com/v4";
const LOW_CREDITS = 50;
const MAX_DAYS_FROM = 3; // the scores endpoint's limit
const RETRY_429_MS = 2500;

export interface OddsApiUsage {
  remaining: number | null;
  used: number | null;
  last: number | null;
}

export class OddsApiSource implements SportSource {
  readonly name = "odds-api";
  readonly quotaBound = true;
  private readonly bookmakers: string[];

  constructor(
    private readonly key: string,
    bookmakers?: string,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => Date = () => new Date()
  ) {
    this.bookmakers = (bookmakers ?? "")
      .split(/[\s,]+/)
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean);
  }

  async slate(league: string, day: string): Promise<GameInfo[]> {
    const { startUtc, endUtc } = etDayBoundsUtc(day);
    const params = new URLSearchParams({
      markets: "h2h",
      oddsFormat: "american",
      dateFormat: "iso",
      commenceTimeFrom: startUtc,
      commenceTimeTo: endUtc,
    });
    // Named bookmakers override the region; up to ten still cost one credit.
    if (this.bookmakers.length) params.set("bookmakers", this.bookmakers.join(","));
    else params.set("regions", "us");
    const events = await this.get(`/sports/${sportKey(league)}/odds`, params);
    return parseOddsEvents(events, league, day, this.bookmakers, this.now());
  }

  async results(league: string, day: string): Promise<GameInfo[]> {
    const today = etParts(this.now()).day;
    const age = daysBetween(day, today);
    if (age + 1 > MAX_DAYS_FROM) {
      // Older than the endpoint reaches. Nothing to fetch; the tick voids such
      // games after VOID_AFTER_HOURS, with a log line, rather than asking forever.
      console.warn(`odds-api: ${league} ${day} is ${age} days old, beyond the scores window; not fetched`);
      return [];
    }
    const params = new URLSearchParams({ daysFrom: String(Math.max(1, age + 1)), dateFormat: "iso" });
    const events = await this.get(`/sports/${sportKey(league)}/scores`, params);
    return parseScoreEvents(events, league, day, this.now());
  }

  private async get(path: string, params: URLSearchParams, attempt = 0): Promise<unknown> {
    params.set("apiKey", this.key);
    const resp = await this.fetchImpl(`${API}${path}?${params.toString()}`);
    const usage = readUsage(resp.headers);
    if (resp.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, RETRY_429_MS));
      params.delete("apiKey");
      return this.get(path, params, attempt + 1);
    }
    if (!resp.ok) {
      // Never the URL: it carries the key. The body names the error code
      // (OUT_OF_USAGE_CREDITS, INVALID_KEY, ...), which is what the operator needs.
      const body = (await resp.text().catch(() => "")).slice(0, 200);
      throw new Error(`odds-api ${path}: HTTP ${resp.status} ${body}`);
    }
    console.log(
      `odds-api ${path}: ${usage.last ?? "?"} credit(s), ${usage.remaining ?? "?"} left this month`
    );
    if (usage.remaining !== null && usage.remaining < LOW_CREDITS) {
      console.warn(`odds-api: only ${usage.remaining} credits left this month; grading stops at 0`);
    }
    return resp.json();
  }
}

export function sportKey(league: string): string {
  const key = ODDS_API_SPORTS[league];
  if (!key) throw new Error(`odds-api has no sport key for league ${JSON.stringify(league)}`);
  return key;
}

export function readUsage(headers: Headers): OddsApiUsage {
  const num = (name: string) => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return { remaining: num("x-requests-remaining"), used: num("x-requests-used"), last: num("x-requests-last") };
}

/** Whole ET days from `day` to `today` (0 when equal, negative when `day` is ahead). */
export function daysBetween(day: string, today: string): number {
  return Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
}

function base(ev: any, league: string, now: Date): Omit<GameInfo, "completed" | "winner" | "awayScore" | "homeScore"> | null {
  const id = ev?.id;
  const home = ev?.home_team;
  const away = ev?.away_team;
  const start = ev?.commence_time;
  if (!id || typeof home !== "string" || typeof away !== "string" || typeof start !== "string") return null;
  if (Number.isNaN(Date.parse(start))) return null;
  return {
    gameId: String(id),
    league,
    startUtc: start,
    // No abbreviations from this source: the full name is the button label too.
    away,
    home,
    awayName: away,
    homeName: home,
    awayLogo: null,
    homeLogo: null,
    state: Date.parse(start) > now.getTime() ? "pre" : "in",
    odds: null,
    homeMl: null,
    awayMl: null,
    drawMl: null,
  };
}

/** Odds endpoint payload -> the day's games with lines from one bookmaker. Pure. */
export function parseOddsEvents(
  payload: unknown,
  league: string,
  day: string,
  preferred: string[],
  now: Date
): GameInfo[] {
  const games: GameInfo[] = [];
  for (const ev of Array.isArray(payload) ? payload : []) {
    const g = base(ev, league, now);
    if (!g || etParts(new Date(g.startUtc)).day !== day) continue;
    const books: any[] = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
    const market = pickMarket(books, preferred);
    const price = (name: string): number | null => {
      const o = market?.outcomes?.find((x: any) => x?.name === name);
      const n = Number(o?.price);
      return o && Number.isFinite(n) && Math.abs(n) >= 100 ? n : null;
    };
    games.push({
      ...g,
      completed: false,
      winner: null,
      awayScore: null,
      homeScore: null,
      homeMl: price(g.home),
      awayMl: price(g.away),
      drawMl: DRAW_LEAGUES.has(league) ? price("Draw") : null,
    });
  }
  return games;
}

// The first preferred bookmaker that quotes h2h, else the first bookmaker that does.
function pickMarket(books: any[], preferred: string[]): any | null {
  const h2h = (b: any) => (Array.isArray(b?.markets) ? b.markets.find((m: any) => m?.key === "h2h") : null);
  for (const key of preferred) {
    const m = h2h(books.find((b) => b?.key === key));
    if (m) return m;
  }
  for (const b of books) {
    const m = h2h(b);
    if (m) return m;
  }
  return null;
}

/** Scores endpoint payload -> the day's games with results. Pure. */
export function parseScoreEvents(payload: unknown, league: string, day: string, now: Date): GameInfo[] {
  const games: GameInfo[] = [];
  for (const ev of Array.isArray(payload) ? payload : []) {
    const g = base(ev, league, now);
    if (!g || etParts(new Date(g.startUtc)).day !== day) continue;
    const completed = ev.completed === true;
    const score = (name: string): number | null => {
      const s = Array.isArray(ev.scores) ? ev.scores.find((x: any) => x?.name === name) : null;
      const n = parseInt(String(s?.score), 10);
      return Number.isFinite(n) ? n : null;
    };
    const homeScore = score(g.home);
    const awayScore = score(g.away);
    let winner: string | null = null;
    if (completed) {
      if (homeScore !== null && awayScore !== null && homeScore !== awayScore) {
        winner = homeScore > awayScore ? "home" : "away";
      } else if (homeScore !== null && homeScore === awayScore && DRAW_LEAGUES.has(league)) {
        winner = "draw";
      } else {
        winner = "void"; // completed with no usable score: nobody scores
      }
    }
    games.push({ ...g, state: completed ? "post" : g.state, completed, winner, homeScore, awayScore });
  }
  return games;
}

/** Exported for tests: the next ET day, so a slate window can be asserted. */
export const nextDay = (day: string): string => shiftDay(day, 1);
