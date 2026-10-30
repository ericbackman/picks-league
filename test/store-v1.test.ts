// v1 store queries against real SQLite with the real schema.sql applied.
//
// Added for the recap-retry fix: `daysFullyGraded` is the query that makes a
// missed recap recoverable at all, so it gets a test rather than a hope.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { asD1, FakeD1 } from "./helpers/fake-d1";
import { Store } from "../src/store";

const SCHEMA = readFileSync("schema.sql", "utf8");

let db: FakeD1;
let store: Store;

function game(id: string, day: string, graded: number, league = "nba") {
  db.query(
    "INSERT INTO games(game_id, league, day, away, home, away_name, home_name, start_utc, graded) " +
      "VALUES(?,?,?,'BOS','TOR','Celtics','Raptors','2026-06-13T23:00:00Z',?)",
    id,
    league,
    day,
    graded
  );
}

beforeEach(() => {
  db = new FakeD1(SCHEMA);
  store = new Store(asD1(db));
});

describe("daysFullyGraded", () => {
  it("returns a day only once every game in it is graded", async () => {
    game("g1", "2026-06-13", 1);
    game("g2", "2026-06-13", 0);
    expect(await store.daysFullyGraded()).toEqual([]);

    db.query("UPDATE games SET graded = 1 WHERE game_id = 'g2'");
    expect(await store.daysFullyGraded()).toEqual(["2026-06-13"]);
  });

  it("is the only way a missed recap can be found again", async () => {
    // The bug: daysWithUngraded drops a day the moment its last game grades, so
    // a day whose recap failed to post can never reappear.
    game("g1", "2026-06-13", 1);
    expect(await store.daysWithUngraded()).toEqual([]);
    expect(await store.daysFullyGraded()).toEqual(["2026-06-13"]);
  });

  it("spans leagues — a day is done when every league's games are", async () => {
    // the private original posts several leagues on one day; the recap covers all of them.
    game("g1", "2026-06-13", 1, "nba");
    game("g2", "2026-06-13", 0, "mlb");
    expect(await store.daysFullyGraded()).toEqual([]);

    db.query("UPDATE games SET graded = 1 WHERE game_id = 'g2'");
    expect(await store.daysFullyGraded()).toEqual(["2026-06-13"]);
  });

  it("is newest-first and bounded, so it cannot grow with the archive", async () => {
    for (const [i, day] of ["2026-06-11", "2026-06-12", "2026-06-13"].entries()) {
      game(`g${i}`, day, 1);
    }
    expect(await store.daysFullyGraded()).toEqual(["2026-06-13", "2026-06-12", "2026-06-11"]);
    expect(await store.daysFullyGraded(2)).toEqual(["2026-06-13", "2026-06-12"]);
  });

  it("ignores a day with no games at all", async () => {
    expect(await store.daysFullyGraded()).toEqual([]);
  });
});
