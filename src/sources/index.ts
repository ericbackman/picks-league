// The data-source seam. Everything the tick needs from the outside world is two
// calls: the day's games with their lines (to post the slate) and the day's games
// with their results (to grade). A source answers both for one league key from
// espn.ts LEAGUES, in the GameInfo shape, so tick.ts never knows which API it is
// talking to.
//
// The default is The Odds API, which has published terms that allow API use, a
// free tier and a key. ESPN's undocumented scoreboard stays as an opt-in for
// people who have read the README's warning about its terms.

import type { Env } from "../discord";
import { fetchScoreboard, type GameInfo } from "../espn";
import { OddsApiSource } from "./odds-api";

export interface SportSource {
  readonly name: string;
  /**
   * True when every call spends a metered quota. The tick then grades on the
   * GRADE_HOURS schedule instead of every 15 minutes (see tick.ts).
   */
  readonly quotaBound: boolean;
  /** The league's games on an ET day, with whatever lines exist yet. */
  slate(league: string, day: string): Promise<GameInfo[]>;
  /** The same games with their state and scores, for grading. */
  results(league: string, day: string): Promise<GameInfo[]>;
}

/** ESPN's public scoreboard: one call answers both questions. Opt-in. */
export const espnSource: SportSource = {
  name: "espn",
  quotaBound: false,
  slate: (league, day) => fetchScoreboard(league, yyyymmddOf(day)),
  results: (league, day) => fetchScoreboard(league, yyyymmddOf(day)),
};

function yyyymmddOf(day: string): string {
  return day.replaceAll("-", "");
}

export const SOURCE_NAMES = ["odds-api", "espn"] as const;

/**
 * Pick the source from DATA_SOURCE. Fails loudly on a name nobody wrote and on
 * a missing key: a bot that silently posts nothing is the failure this whole
 * design exists to avoid.
 */
export function sourceFor(env: Pick<Env, "DATA_SOURCE" | "ODDS_API_KEY" | "ODDS_API_BOOKMAKERS">): SportSource {
  const name = (env.DATA_SOURCE ?? "odds-api").trim().toLowerCase();
  switch (name) {
    case "odds-api": {
      const key = env.ODDS_API_KEY?.trim();
      if (!key) {
        throw new Error(
          "ODDS_API_KEY is not set. Get a free key at https://the-odds-api.com and " +
            "`npx wrangler secret put ODDS_API_KEY`, or set DATA_SOURCE=espn (read the README first)."
        );
      }
      return new OddsApiSource(key, env.ODDS_API_BOOKMAKERS);
    }
    case "espn":
      return espnSource;
    default:
      throw new Error(`DATA_SOURCE=${name} is not one of: ${SOURCE_NAMES.join(", ")}`);
  }
}
