// The data-source seam. Everything the tick needs from the outside world is two
// calls: the day's games with their lines (to post the slate) and the day's games
// with their results (to grade). A source answers both for one league key from
// leagues.ts, in the GameInfo shape, so tick.ts never knows which API it is
// talking to. One source ships: The Odds API, whose published terms allow
// exactly this use. Another goes in this folder and in the switch below; its
// terms go in the README first.

import type { Env } from "../discord";
import type { GameInfo } from "../leagues";
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

export const SOURCE_NAMES = ["odds-api"] as const;

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
            "`npx wrangler secret put ODDS_API_KEY`."
        );
      }
      return new OddsApiSource(key, env.ODDS_API_BOOKMAKERS);
    }
    default:
      throw new Error(`DATA_SOURCE=${name} is not one of: ${SOURCE_NAMES.join(", ")}`);
  }
}
