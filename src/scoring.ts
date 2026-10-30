// Scoring policy and standings math. Pure functions — no Discord, no D1.
// `pointsFor` is the tuning seam: pure, deterministic, finite, >= 0, pinned by
// tests, and only ever called for a correct pick.

import { payoutFor, type MlGame } from "./odds";
import type { GradedRow } from "./store";

export interface ScorableGame extends MlGame {
  league: string;
  away_name: string;
  home_name: string;
  winner: string | null;
  away_score: number | null;
  home_score: number | null;
  start_utc: string;
}

/**
 * How many points a CORRECT pick of `side` earns for this game.
 *
 * THE TUNING SPOT. Contract, pinned by tests: pure, never throws,
 * returns a finite number >= 0, deterministic. Wrong picks never reach
 * here — they always score 0.
 *
 * A correct pick scores its fair decimal odds, like a
 * 1-unit bet — vig-stripped from the stored moneylines the data source published
 * (home_ml/away_ml/draw_ml), capped at 10, coin-flip 2.0 when no market
 * exists. The payout shown on the slate IS this number, so keep display
 * and scoring in sync (both call payoutFor).
 *
 * Knobs worth tuning later: the cap (odds.ts), league weighting
 * (playoff multipliers), or World Cup knockout-round bonuses.
 */
export function pointsFor(side: string, game: ScorableGame): number {
  return payoutFor(side, game);
}

export interface Standing {
  name: string;
  points: number;
  wins: number;
  losses: number;
}

/**
 * Aggregate graded pick rows into sorted standings. Voided games don't count
 * for or against anyone. Best first; ties broken by wins, then fewer losses.
 */
export function standings(rows: GradedRow[]): Standing[] {
  const byUser = new Map<string, Standing>();
  for (const row of rows) {
    if (row.winner === "void") continue;
    let entry = byUser.get(row.user_id);
    if (!entry) {
      entry = { name: row.user_name, points: 0, wins: 0, losses: 0 };
      byUser.set(row.user_id, entry);
    }
    entry.name = row.user_name; // latest display name wins
    if (row.side === row.winner) {
      entry.wins += 1;
      entry.points += row.points ?? 0;
    } else {
      entry.losses += 1;
    }
  }
  return [...byUser.values()].sort(
    (a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses
  );
}

/**
 * Split graded rows into one standings table per league, in the order given by
 * `leagues`. Each table is just standings() restricted to that league's rows —
 * so a per-sport board ranks identically to the overall board, only narrower.
 * Pure; the caller passes humans-only rows (no Bookie) the same as standings().
 *
 * A league with no graded picks yet (e.g. World Cup before kickoff) is OMITTED,
 * so the pinned board grows as sports come online instead of showing empty
 * "⚽ —" sections. standings() already collapses voids/empty input to [], so an
 * untouched league naturally yields an empty table, which we drop here.
 */
export function standingsByLeague(
  rows: GradedRow[],
  leagues: string[]
): { league: string; table: Standing[] }[] {
  const boards: { league: string; table: Standing[] }[] = [];
  for (const league of leagues) {
    const table = standings(rows.filter((r) => r.league === league));
    if (table.length) boards.push({ league, table }); // omit leagues with no graded picks
  }
  return boards;
}

/** 3.0 → "3", 3.5 → "3.5" — keep the leaderboard tidy for integer scores. */
export function fmtPoints(points: number): string {
  return String(Number(points.toFixed(2)));
}

export interface Streak {
  user_id: string;
  name: string;
  streak: number; // trailing run of correct picks, in chronological order
}

/**
 * Current hot streak per user: how many of their MOST RECENT graded picks in a
 * row were correct. Input MUST be in chronological order (oldest first) — a
 * wrong pick resets the count, a correct one extends it, so the value after the
 * last pick is the live streak. Only streaks of 1+ are returned, best first.
 * Pure; voided games should already be filtered out by the caller.
 */
export function currentStreaks(rows: GradedRow[]): Streak[] {
  const byUser = new Map<string, Streak>();
  for (const row of rows) {
    let entry = byUser.get(row.user_id);
    if (!entry) {
      entry = { user_id: row.user_id, name: row.user_name, streak: 0 };
      byUser.set(row.user_id, entry);
    }
    entry.name = row.user_name;
    entry.streak = row.side === row.winner ? entry.streak + 1 : 0;
  }
  return [...byUser.values()].filter((s) => s.streak > 0).sort((a, b) => b.streak - a.streak);
}
