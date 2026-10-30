// Time helpers (the ET day boundary is load-bearing — cron is UTC) and
// league-spec parsing/filtering.

import { describe, expect, it } from "vitest";
import type { GameInfo } from "../src/espn";
import {
  BOOKIE_ID,
  buildSportBoards,
  etParts,
  filterGames,
  fmtEt,
  matchupLabel,
  parseLeagueSpecs,
  prettyDay,
  sportBoardField,
  unknownLeagues,
  yyyymmdd,
} from "../src/tick";
import type { GradedRow } from "../src/store";

describe("etParts", () => {
  it("maps a UTC evening to the same ET day", () => {
    // 2026-06-12 18:00 UTC = 14:00 EDT
    expect(etParts(new Date("2026-06-12T18:00:00Z"))).toEqual({ day: "2026-06-12", hour: 14 });
  });

  it("rolls back to the previous ET day after UTC midnight", () => {
    // 2026-06-13 02:00 UTC = 2026-06-12 22:00 EDT — still game night
    expect(etParts(new Date("2026-06-13T02:00:00Z"))).toEqual({ day: "2026-06-12", hour: 22 });
  });

  it("handles winter (EST, UTC-5)", () => {
    // 2026-01-10 04:30 UTC = 2026-01-09 23:30 EST
    expect(etParts(new Date("2026-01-10T04:30:00Z"))).toEqual({ day: "2026-01-09", hour: 23 });
  });
});

describe("formatting", () => {
  it("formats ET game times", () => {
    expect(fmtEt("2026-06-12T22:40Z")).toBe("6:40 PM ET");
  });

  it("returns TBD for garbage timestamps", () => {
    expect(fmtEt("not a date")).toBe("TBD");
  });

  it("pretty-prints days without timezone drift", () => {
    expect(prettyDay("2026-06-12")).toBe("Friday, June 12");
  });

  it("compacts days for ESPN", () => {
    expect(yyyymmdd("2026-06-12")).toBe("20260612");
  });

  it("labels soccer home-first, everything else away-at-home", () => {
    expect(matchupLabel("wc", "Bosnia-Herz", "Canada")).toBe("Canada vs Bosnia-Herz");
    expect(matchupLabel("mlb", "Marlins", "Pirates")).toBe("Marlins @ Pirates");
  });
});

describe("league specs", () => {
  it("parses whole leagues and team filters", () => {
    const specs = parseLeagueSpecs("nba nhl wc mlb:TOR");
    expect(specs).toHaveLength(4);
    expect(specs[0]).toEqual({ key: "nba", teams: null });
    expect(specs[3].key).toBe("mlb");
    expect([...specs[3].teams!]).toEqual(["TOR"]);
  });

  it("accepts multiple teams with + or , and normalizes case", () => {
    const [spec] = parseLeagueSpecs("MLB:tor+nyy");
    expect(spec.key).toBe("mlb");
    expect(spec.teams).toEqual(new Set(["TOR", "NYY"]));
    expect(parseLeagueSpecs("mlb:tor,nyy")[0].teams).toEqual(new Set(["TOR", "NYY"]));
  });

  it("treats an empty team list as the whole league", () => {
    expect(parseLeagueSpecs("mlb:")[0].teams).toBeNull();
  });

  it("flags unknown league keys", () => {
    expect(unknownLeagues(parseLeagueSpecs("nba xfl wc"))).toEqual(["xfl"]);
    expect(unknownLeagues(parseLeagueSpecs("nba nhl wc mlb:TOR"))).toEqual([]);
  });

  it("filters games to the named teams", () => {
    const game = (away: string, home: string) => ({ away, home }) as GameInfo;
    const games = [game("MIA", "PIT"), game("TOR", "BAL"), game("SEA", "TOR")];
    const [spec] = parseLeagueSpecs("mlb:TOR");
    expect(filterGames(games, spec).map((g) => `${g.away}@${g.home}`)).toEqual([
      "TOR@BAL",
      "SEA@TOR",
    ]);
    expect(filterGames(games, parseLeagueSpecs("mlb")[0])).toHaveLength(3);
  });
});

describe("sport boards (the pinned board + daily recap split)", () => {
  // eric wins 2 WC games; dave wins 1 WC + 1 MLB. NHL isn't in SPORT_BOARDS.
  // Bookie carries a benchmark score in each league.
  const rows: GradedRow[] = [
    { user_id: "1", user_name: "eric", side: "home", points: 2, winner: "home", league: "wc" },
    { user_id: "1", user_name: "eric", side: "away", points: 3, winner: "away", league: "wc" },
    { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "wc" },
    { user_id: "2", user_name: "dave", side: "home", points: 1, winner: "home", league: "mlb" },
    { user_id: "1", user_name: "eric", side: "away", points: null, winner: "home", league: "mlb" },
    { user_id: "1", user_name: "eric", side: "home", points: 1, winner: "home", league: "nhl" },
    { user_id: BOOKIE_ID, user_name: "Bookie", side: "home", points: 5, winner: "home", league: "wc" },
    { user_id: BOOKIE_ID, user_name: "Bookie", side: "home", points: 4, winner: "home", league: "mlb" },
  ];

  it("builds one board per SPORT_BOARDS league, in order, humans only", () => {
    const boards = buildSportBoards(rows);
    expect(boards.map((b) => b.label)).toEqual(["World Cup", "Baseball"]);
    expect(boards[0].icon).toBe("⚽");
    expect(boards[1].icon).toBe("⚾");
    // WC: eric (2+3=5 pts) over dave (1). Bookie is never a ranked row.
    expect(boards[0].table.map((e) => e.name)).toEqual(["eric", "dave"]);
    expect(boards[0].table[0].points).toBe(5);
  });

  it("carries the Bookie's per-league points as the benchmark", () => {
    const boards = buildSportBoards(rows);
    expect(boards[0].bookiePoints).toBe(5); // WC
    expect(boards[1].bookiePoints).toBe(4); // MLB
  });

  it("omits leagues not in SPORT_BOARDS (NHL) and leagues with no graded picks", () => {
    // NHL has a graded pick but no board; drop MLB entirely -> only World Cup.
    const wcOnly = rows.filter((r) => r.league === "wc");
    expect(buildSportBoards(wcOnly).map((b) => b.label)).toEqual(["World Cup"]);
  });

  it("renders a per-sport field with medals, points, and the benchmark", () => {
    const field = sportBoardField(buildSportBoards(rows)[0]);
    expect(field.name).toBe("⚽ World Cup");
    expect(field.inline).toBe(true);
    expect(field.value).toContain("🥇 eric 5 pts");
    expect(field.value).toContain("🥈 dave 1 pts");
    expect(field.value).toContain("🤖 5 to beat");
  });

  it("drops the benchmark line when the Bookie hasn't played that league", () => {
    const humanWc = rows.filter((r) => r.user_id !== BOOKIE_ID && r.league === "wc");
    const field = sportBoardField(buildSportBoards(humanWc)[0]);
    expect(field.value).not.toContain("to beat");
  });
});
