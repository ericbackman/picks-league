// Port of the original bot's scoring tests. pointsFor's contract is pinned here so
// Eric's scoring rewrites can't break grading: pure, finite, >= 0,
// deterministic.

import { describe, expect, it } from "vitest";
import {
  currentStreaks,
  fmtPoints,
  pointsFor,
  standings,
  standingsByLeague,
  type ScorableGame,
} from "../src/scoring";

const GAME: ScorableGame = {
  league: "mlb",
  away: "MIA",
  home: "PIT",
  away_name: "Marlins",
  home_name: "Pirates",
  odds: "PIT -143",
  home_ml: -143,
  away_ml: 119,
  draw_ml: null,
  winner: "home",
  away_score: 2,
  home_score: 5,
  start_utc: "2026-06-12T22:40Z",
};

describe("pointsFor contract", () => {
  it("returns a finite non-negative number, deterministically", () => {
    for (const side of ["home", "away"]) {
      const value = pointsFor(side, GAME);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(pointsFor(side, GAME)).toBe(value);
    }
  });

  it("pays underdog calls more than chalk calls", () => {
    expect(pointsFor("away", GAME)).toBeGreaterThan(pointsFor("home", GAME));
  });

  it("survives missing odds entirely", () => {
    const bare = { ...GAME, odds: null, home_ml: null, away_ml: null };
    expect(pointsFor("home", bare)).toBeGreaterThanOrEqual(0);
  });
});

describe("standings", () => {
  it("aggregates, sorts, and excludes voids", () => {
    const rows = [
      { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "mlb" },
      { user_id: "1", user_name: "eric", side: "away", points: null, winner: "home", league: "mlb" },
      { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "wc" },
      { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "wc" },
      { user_id: "3", user_name: "sam", side: "away", points: null, winner: "void", league: "mlb" },
    ];
    const table = standings(rows);
    expect(table.map((e) => e.name)).toEqual(["dave", "eric"]); // sam only had a void
    expect(table[0]).toMatchObject({ points: 2, wins: 2, losses: 0 });
    expect(table[1]).toMatchObject({ points: 1, wins: 1, losses: 1 });
  });

  it("uses the latest display name", () => {
    const rows = [
      { user_id: "1", user_name: "old_name", side: "home", points: 1, winner: "home", league: "mlb" },
      { user_id: "1", user_name: "new_name", side: "home", points: 1, winner: "home", league: "mlb" },
    ];
    expect(standings(rows)[0].name).toBe("new_name");
  });
});

describe("standingsByLeague", () => {
  // eric: wins WC (+2), loses MLB.  dave: loses WC, wins MLB (+1).
  const rows = [
    { user_id: "1", user_name: "eric", side: "home", points: 2, winner: "home", league: "wc" },
    { user_id: "2", user_name: "dave", side: "away", points: 0, winner: "home", league: "wc" },
    { user_id: "1", user_name: "eric", side: "away", points: 0, winner: "home", league: "mlb" },
    { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "mlb" },
  ];

  it("makes one ranked table per league, in the order requested", () => {
    const boards = standingsByLeague(rows, ["wc", "mlb"]);
    expect(boards.map((b) => b.league)).toEqual(["wc", "mlb"]);
    expect(boards[0].table.map((e) => e.name)).toEqual(["eric", "dave"]); // WC: eric on top
    expect(boards[0].table[0]).toMatchObject({ points: 2, wins: 1, losses: 0 });
    expect(boards[1].table.map((e) => e.name)).toEqual(["dave", "eric"]); // MLB: dave on top
    expect(boards[1].table[0]).toMatchObject({ points: 1, wins: 1, losses: 0 });
  });

  it("scopes each table to its own league — no cross-sport bleed", () => {
    const [wc] = standingsByLeague(rows, ["wc"]);
    const eric = wc.table.find((e) => e.name === "eric")!;
    expect(eric).toMatchObject({ points: 2, wins: 1 });
    expect(eric.losses).toBe(0); // eric's MLB loss must not count against his WC board
  });

  it("omits a league with no graded picks", () => {
    expect(standingsByLeague(rows, ["wc", "nba"]).map((b) => b.league)).toEqual(["wc"]);
  });
});

describe("fmtPoints", () => {
  it("trims integer floats", () => {
    expect(fmtPoints(3.0)).toBe("3");
    expect(fmtPoints(3.5)).toBe("3.5");
  });
});

describe("currentStreaks", () => {
  // Chronological order is the contract — these rows are oldest-first.
  it("counts only the trailing run of correct picks", () => {
    const rows = [
      { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "mlb" }, // ✓
      { user_id: "1", user_name: "eric", side: "away", points: 0, winner: "home", league: "mlb" }, // ✗ resets
      { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "mlb" }, // ✓
      { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "mlb" }, // ✓ -> streak 2
    ];
    expect(currentStreaks(rows)).toEqual([{ user_id: "1", name: "eric", streak: 2 }]);
  });

  it("drops users whose last pick was wrong, sorts hottest first", () => {
    const rows = [
      { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "mlb" }, // ✓ -> 1
      { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "mlb" }, // ✓
      { user_id: "2", user_name: "dave", side: "away", points: 0, winner: "home", league: "mlb" }, // ✗ -> dropped
      { user_id: "3", user_name: "sam", side: "draw", points: 3, winner: "draw", league: "wc" }, // ✓
      { user_id: "3", user_name: "sam", side: "draw", points: 3, winner: "draw", league: "wc" }, // ✓ -> 2
    ];
    expect(currentStreaks(rows)).toEqual([
      { user_id: "3", name: "sam", streak: 2 },
      { user_id: "1", name: "eric", streak: 1 },
    ]);
  });

  it("is empty when nobody is on a streak", () => {
    expect(currentStreaks([])).toEqual([]);
  });
});
