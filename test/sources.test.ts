// The data-source seam: picking a source from the environment, and The Odds
// API's two pure parsers plus its credit accounting, against fixtures in the
// shape its v4 guide documents (opened 2026-10-30).
import { describe, expect, it } from "vitest";
import { sourceFor } from "../src/sources";
import {
  daysBetween,
  OddsApiSource,
  parseOddsEvents,
  parseScoreEvents,
  readUsage,
  sportKey,
} from "../src/sources/odds-api";
import { etDayBoundsUtc } from "../src/time";

const NOW = new Date("2026-10-30T15:00:00Z"); // 11:00 ET on 2026-10-30

const oddsPayload = [
  {
    id: "e1",
    sport_key: "basketball_nba",
    commence_time: "2026-10-30T23:30:00Z", // 7:30pm ET, same ET day
    home_team: "Toronto Raptors",
    away_team: "Boston Celtics",
    bookmakers: [
      {
        key: "fanduel",
        title: "FanDuel",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Toronto Raptors", price: 140 },
              { name: "Boston Celtics", price: -165 },
            ],
          },
        ],
      },
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "Toronto Raptors", price: 135 },
              { name: "Boston Celtics", price: -160 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "e2",
    commence_time: "2026-10-31T02:30:00Z", // 10:30pm ET on the 30th: still that day
    home_team: "Los Angeles Lakers",
    away_team: "Denver Nuggets",
    bookmakers: [], // no lines yet
  },
  {
    id: "e3",
    commence_time: "2026-10-31T23:00:00Z", // tomorrow ET: filtered out
    home_team: "Miami Heat",
    away_team: "Chicago Bulls",
    bookmakers: [],
  },
  { id: "bad", commence_time: "not a date", home_team: "X", away_team: "Y" },
];

describe("parseOddsEvents", () => {
  it("keeps the ET day's games and takes lines from the first bookmaker", () => {
    const games = parseOddsEvents(oddsPayload, "nba", "2026-10-30", [], NOW);
    expect(games.map((g) => g.gameId)).toEqual(["e1", "e2"]);
    const [tor, lal] = games;
    expect(tor).toMatchObject({
      league: "nba",
      away: "Boston Celtics",
      home: "Toronto Raptors",
      awayName: "Boston Celtics",
      state: "pre",
      completed: false,
      winner: null,
      homeMl: 140,
      awayMl: -165,
      drawMl: null,
    });
    expect(lal).toMatchObject({ homeMl: null, awayMl: null });
  });

  it("prefers a named bookmaker when it quotes the market", () => {
    const [tor] = parseOddsEvents(oddsPayload, "nba", "2026-10-30", ["draftkings"], NOW);
    expect(tor.homeMl).toBe(135);
    // A preferred book that is absent falls through to the first one quoting.
    const [again] = parseOddsEvents(oddsPayload, "nba", "2026-10-30", ["nobody"], NOW);
    expect(again.homeMl).toBe(140);
  });

  it("reads the draw price in a draw league and marks a started game as live", () => {
    const payload = [
      {
        id: "s1",
        commence_time: "2026-10-30T14:00:00Z", // 10:00 ET, already started at NOW
        home_team: "Canada",
        away_team: "Mexico",
        bookmakers: [
          {
            key: "fanduel",
            markets: [
              {
                key: "h2h",
                outcomes: [
                  { name: "Canada", price: 210 },
                  { name: "Mexico", price: 150 },
                  { name: "Draw", price: 220 },
                ],
              },
            ],
          },
        ],
      },
    ];
    const [g] = parseOddsEvents(payload, "wc", "2026-10-30", [], NOW);
    expect(g).toMatchObject({ state: "in", homeMl: 210, awayMl: 150, drawMl: 220 });
  });
});

describe("parseScoreEvents", () => {
  const payload = [
    {
      id: "e1",
      commence_time: "2026-10-29T23:30:00Z",
      completed: true,
      home_team: "Toronto Raptors",
      away_team: "Boston Celtics",
      scores: [
        { name: "Toronto Raptors", score: "113" },
        { name: "Boston Celtics", score: "108" },
      ],
      last_update: "2026-10-30T02:10:00Z",
    },
    {
      id: "e2",
      commence_time: "2026-10-30T02:30:00Z", // 10:30pm ET on the 29th
      completed: false,
      home_team: "Los Angeles Lakers",
      away_team: "Denver Nuggets",
      scores: null,
      last_update: null,
    },
    {
      id: "e9",
      commence_time: "2026-10-30T23:30:00Z", // the 30th: not this day
      completed: false,
      home_team: "A",
      away_team: "B",
      scores: null,
    },
  ];

  it("grades a completed game by score and leaves the rest ungraded", () => {
    const games = parseScoreEvents(payload, "nba", "2026-10-29", NOW);
    expect(games.map((g) => g.gameId)).toEqual(["e1", "e2"]);
    expect(games[0]).toMatchObject({ completed: true, state: "post", winner: "home", homeScore: 113, awayScore: 108 });
    expect(games[1]).toMatchObject({ completed: false, winner: null, homeScore: null });
  });

  it("calls a level final a draw only in a draw league, else void", () => {
    const level = [
      { ...payload[0], scores: [{ name: "Toronto Raptors", score: "2" }, { name: "Boston Celtics", score: "2" }] },
    ];
    expect(parseScoreEvents(level, "nba", "2026-10-29", NOW)[0].winner).toBe("void");
    const soccer = [
      { ...level[0], home_team: "Canada", away_team: "Mexico", scores: [{ name: "Canada", score: "1" }, { name: "Mexico", score: "1" }] },
    ];
    expect(parseScoreEvents(soccer, "wc", "2026-10-29", NOW)[0].winner).toBe("draw");
    const noScore = [{ ...payload[0], scores: null }];
    expect(parseScoreEvents(noScore, "nba", "2026-10-29", NOW)[0].winner).toBe("void");
  });
});

describe("OddsApiSource requests", () => {
  function fakeFetch(capture: { url?: string }, body: unknown, headers: Record<string, string> = {}, status = 200) {
    return (async (input: RequestInfo | URL) => {
      capture.url = String(input);
      return new Response(JSON.stringify(body), { status, headers });
    }) as typeof fetch;
  }

  it("asks for one h2h market in the US region inside the ET day, with the key in the query", async () => {
    const cap: { url?: string } = {};
    const headers = { "x-requests-remaining": "480", "x-requests-last": "1" };
    const src = new OddsApiSource("k3y", undefined, fakeFetch(cap, [], headers), () => NOW);
    expect(await src.slate("nba", "2026-10-30")).toEqual([]);
    const url = new URL(cap.url!);
    expect(url.pathname).toBe("/v4/sports/basketball_nba/odds");
    expect(url.searchParams.get("apiKey")).toBe("k3y");
    expect(url.searchParams.get("markets")).toBe("h2h");
    expect(url.searchParams.get("regions")).toBe("us");
    expect(url.searchParams.get("oddsFormat")).toBe("american");
    expect(url.searchParams.get("commenceTimeFrom")).toBe("2026-10-30T04:00:00Z");
    expect(url.searchParams.get("commenceTimeTo")).toBe("2026-10-31T03:59:59Z");
  });

  it("names bookmakers instead of a region when asked", async () => {
    const cap: { url?: string } = {};
    const src = new OddsApiSource("k", "fanduel, draftkings", fakeFetch(cap, []), () => NOW);
    await src.slate("nhl", "2026-10-30");
    const url = new URL(cap.url!);
    expect(url.searchParams.get("bookmakers")).toBe("fanduel,draftkings");
    expect(url.searchParams.get("regions")).toBeNull();
  });

  it("fetches scores with daysFrom sized to the day's age, and skips days too old to fetch", async () => {
    const cap: { url?: string } = {};
    const src = new OddsApiSource("k", undefined, fakeFetch(cap, []), () => NOW);
    await src.results("mlb", "2026-10-30");
    expect(new URL(cap.url!).searchParams.get("daysFrom")).toBe("1");
    await src.results("mlb", "2026-10-28");
    expect(new URL(cap.url!).searchParams.get("daysFrom")).toBe("3");
    cap.url = undefined;
    expect(await src.results("mlb", "2026-10-26")).toEqual([]);
    expect(cap.url).toBeUndefined(); // no call made
  });

  it("throws with the status and body, never the URL", async () => {
    const cap: { url?: string } = {};
    const src = new OddsApiSource("secret", undefined, fakeFetch(cap, { message: "OUT_OF_USAGE_CREDITS" }, {}, 401), () => NOW);
    await expect(src.slate("nba", "2026-10-30")).rejects.toThrow(/HTTP 401.*OUT_OF_USAGE_CREDITS/);
    await expect(src.slate("nba", "2026-10-30")).rejects.not.toThrow(/secret/);
  });
});

describe("helpers", () => {
  it("maps leagues to sport keys and refuses unknown ones", () => {
    expect(sportKey("nfl")).toBe("americanfootball_nfl");
    expect(sportKey("wc")).toBe("soccer_fifa_world_cup");
    expect(() => sportKey("cfl")).toThrow(/no sport key/);
  });

  it("reads the credit headers", () => {
    const h = new Headers({ "x-requests-remaining": "12", "x-requests-used": "488", "x-requests-last": "2" });
    expect(readUsage(h)).toEqual({ remaining: 12, used: 488, last: 2 });
    expect(readUsage(new Headers())).toEqual({ remaining: null, used: null, last: null });
  });

  it("counts whole days between ET days", () => {
    expect(daysBetween("2026-10-30", "2026-10-30")).toBe(0);
    expect(daysBetween("2026-10-28", "2026-10-30")).toBe(2);
    expect(daysBetween("2026-10-31", "2026-10-30")).toBe(-1);
  });

  it("finds ET midnight on both sides of the DST change", () => {
    expect(etDayBoundsUtc("2026-10-30")).toEqual({ startUtc: "2026-10-30T04:00:00Z", endUtc: "2026-10-31T03:59:59Z" });
    // Clocks fall back on 2026-11-01: that day is 25 hours long.
    expect(etDayBoundsUtc("2026-11-01")).toEqual({ startUtc: "2026-11-01T04:00:00Z", endUtc: "2026-11-02T04:59:59Z" });
    expect(etDayBoundsUtc("2026-12-25")).toEqual({ startUtc: "2026-12-25T05:00:00Z", endUtc: "2026-12-26T04:59:59Z" });
  });
});

describe("sourceFor", () => {
  it("defaults to The Odds API and demands its key", () => {
    expect(() => sourceFor({})).toThrow(/ODDS_API_KEY/);
    expect(sourceFor({ ODDS_API_KEY: "k" }).name).toBe("odds-api");
    expect(sourceFor({ ODDS_API_KEY: "k" }).quotaBound).toBe(true);
  });

  it("refuses a source name nobody wrote", () => {
    expect(() => sourceFor({ DATA_SOURCE: "yahoo" })).toThrow(/DATA_SOURCE=yahoo/);
    expect(() => sourceFor({ DATA_SOURCE: "espn" })).toThrow(/DATA_SOURCE=espn/);
  });
});
