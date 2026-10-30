// Odds math — pure functions, no I/O. American moneylines in, fair
// (vig-stripped) probabilities and payout multipliers out.
//
// The scoring philosophy: a correct pick "pays" its fair decimal odds, like
// a 1-unit bet. Favorites pay a little, dogs pay a lot, and the number shown
// on the slate is exactly what the pick scores — the display teaches the
// odds.

export interface MlGame {
  home_ml: number | null;
  away_ml: number | null;
  draw_ml: number | null;
  odds: string | null; // legacy "PIT -149" details string (favorite + line)
  away: string;
  home: string;
}

/** American moneyline → implied probability (includes the book's vig). */
export function impliedProb(ml: number): number {
  return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
}

/**
 * Fair win probabilities per side, vig stripped by normalizing the implied
 * probabilities to sum to 1. Includes "draw" only when a draw line exists.
 * Returns null when there isn't a usable two-way market.
 */
export function fairProbs(game: MlGame): Record<string, number> | null {
  let { home_ml: homeMl, away_ml: awayMl } = game;
  if (homeMl === null || awayMl === null) {
    const legacy = legacyProbs(game);
    if (legacy) return legacy;
    return null;
  }
  const raw: Record<string, number> = {
    home: impliedProb(homeMl),
    away: impliedProb(awayMl),
  };
  if (game.draw_ml !== null) raw.draw = impliedProb(game.draw_ml);
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const fair: Record<string, number> = {};
  for (const [side, p] of Object.entries(raw)) fair[side] = p / total;
  return fair;
}

// Fallback for rows stored before per-side moneylines existed: the details
// string ("PIT -149") names the favorite; the other side gets the remainder.
function legacyProbs(game: MlGame): Record<string, number> | null {
  const match = game.odds?.match(/^([A-Z]{2,5})\s+([+-]\d+)$/);
  if (!match) return null;
  const ml = parseInt(match[2], 10);
  if (Math.abs(ml) < 100) return null; // a spread like "BOS -3.5", not a moneyline
  const favProb = impliedProb(ml);
  const favSide = match[1] === game.home ? "home" : match[1] === game.away ? "away" : null;
  if (!favSide) return null;
  return favSide === "home"
    ? { home: favProb, away: 1 - favProb }
    : { home: 1 - favProb, away: favProb };
}

/** What a correct pick of `side` pays, in points. Coin-flip default: 2.0. */
export function payoutFor(side: string, game: MlGame): number {
  const probs = fairProbs(game);
  const p = probs?.[side];
  if (!p || p <= 0) return 2.0;
  // Round to 1 decimal and cap: a +1000 miracle shouldn't decide a season.
  return Math.min(10, Math.round(10 / p) / 10);
}

/** The Bookie always rides the chalk: most probable side, home on a coin flip. */
export function favoriteSide(game: MlGame): string | null {
  const probs = fairProbs(game);
  if (!probs) return null;
  return Object.entries(probs).sort(([, a], [, b]) => b - a)[0][0];
}

export function fmtMl(ml: number): string {
  return ml > 0 ? `+${ml}` : String(ml);
}

export function fmtPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}
