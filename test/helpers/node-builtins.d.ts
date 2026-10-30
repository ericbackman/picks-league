// Minimal ambient types for the node: builtins the test helpers use.
//
// The alternative is adding @types/node to a project whose global type
// environment is @cloudflare/workers-types, and the two disagree about globals
// the Worker actually uses (fetch, console, Buffer). Declaring the three methods
// the fake D1 calls keeps `npm run check` honest without that trade.

declare module "node:sqlite" {
  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown | undefined;
    run(...params: unknown[]): StatementResultingChanges;
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}
