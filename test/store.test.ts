// Store queries against real SQLite with the real migration applied.
//
// Added for the recap-retry fix: `daysFullyGraded` is the query that makes a
// missed recap recoverable at all, so it gets a test rather than a hope.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { asD1, FakeD1 } from "./helpers/fake-d1";
import { Store } from "../src/store";

const SCHEMA = readFileSync("migrations/0001_init.sql", "utf8");

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
    // Several leagues post on one day; the recap covers all of them.
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

describe("forgetUser", () => {
  it("deletes the user's picks, tap history and DM cards, and nobody else's", async () => {
    game("g1", "2026-06-13", 0);
    await store.recordPick("g1", "u1", "Alice", "home");
    await store.recordPick("g1", "u1", "Alice", "away"); // two taps in the log
    await store.recordPick("g1", "u2", "Bob", "home");
    db.query("INSERT INTO dm_cards(user_id, day, dm_channel_id, message_id) VALUES('u1','2026-06-13','c','m')");

    expect(await store.forgetUser("u1")).toBe(1);

    expect((await store.picksForGame("g1")).map((p) => p.user_id)).toEqual(["u2"]);
    expect((await store.pickHistory("g1")).map((e) => e.user_id)).toEqual(["u2"]);
    expect(await store.getDmCard("u1", "2026-06-13")).toBeNull();
  });

  it("returns 0 for a user it has never seen", async () => {
    expect(await store.forgetUser("nobody")).toBe(0);
  });
});

describe("voidStale", () => {
  it("voids only old games with no result", async () => {
    game("old", "2026-06-13", 0); // start 2026-06-13T23:00Z
    game("done", "2026-06-13", 0);
    db.query("UPDATE games SET winner = 'home' WHERE game_id = 'done'");
    expect(await store.voidStale("2026-06-13", "2026-06-16T23:00:00Z")).toBe(1);
    expect((await store.game("old"))?.winner).toBe("void");
    expect((await store.game("done"))?.winner).toBe("home");
    // A cutoff before the start leaves it alone.
    game("fresh", "2026-06-13", 0);
    expect(await store.voidStale("2026-06-13", "2026-06-13T00:00:00Z")).toBe(0);
  });
});
