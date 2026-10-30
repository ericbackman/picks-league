// A D1Database backed by real SQLite (node:sqlite), for testing the v2 store.
//
// Deliberately NOT a mock. D1 *is* SQLite, so running the store's actual SQL
// against a real engine tests the queries — ON CONFLICT clauses, the JOINs, the
// COALESCE fallbacks, `changes` semantics — rather than testing that we called a
// stub with an expected string. A mock would have happily accepted the malformed
// SQL this caught while being written.
//
// Two D1 behaviours it reproduces exactly, because the store depends on both:
//
//   - `bind()` returns a NEW statement. upsertMarkets prepares once and binds per
//     row inside a map; if bind mutated shared state every row would write the
//     last row's values.
//   - `run().meta.changes` is how claimDmCard detects whether IT won the insert
//     race. `ON CONFLICT DO NOTHING` must report 0 changes for the loser.

import { DatabaseSync } from "node:sqlite";

type Bindings = readonly unknown[];

/** Rows out of node:sqlite have a null prototype, which breaks toEqual. */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly bindings: Bindings = []
  ) {}

  bind(...args: unknown[]): FakeStatement {
    // New instance — never mutate. See the note above.
    return new FakeStatement(this.db, this.sql, args);
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.bindings as never[]));
    return row === undefined ? null : plain<T>(row);
  }

  async all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const rows = this.db.prepare(this.sql).all(...(this.bindings as never[]));
    return { results: rows.map((r) => plain<T>(r)), success: true, meta: { changes: 0 } };
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const out = this.db.prepare(this.sql).run(...(this.bindings as never[]));
    return { success: true, meta: { changes: Number(out.changes) } };
  }
}

export class FakeD1 {
  private readonly db: DatabaseSync;

  constructor(schemaSql: string) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(schemaSql);
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }

  /** D1 runs a batch as one transaction. Sequential here is close enough for the
   *  store's uses, and the transaction makes partial application visible if a
   *  later statement throws. */
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const out: unknown[] = [];
      for (const stmt of statements) out.push(await stmt.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Escape hatch for assertions that need to look at raw rows. */
  query<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...(args as never[])).map((r) => plain<T>(r));
  }
}

/** The store only ever sees D1Database; this keeps the cast in one place. */
export function asD1(fake: FakeD1): D1Database {
  return fake as unknown as D1Database;
}
