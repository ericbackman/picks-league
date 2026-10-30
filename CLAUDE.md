# picks-league

A serverless Discord picks league: Cloudflare Worker + D1, TypeScript, no runtime
dependencies. Discord delivers interactions as signed HTTP POSTs; a cron trigger
runs an idempotent tick that posts the day's slate and grades finals, with games,
lines and results from The Odds API. README.md is the user-facing document;
docs/OPERATIONS.md is the runbook for a live deployment.

## Structure

```
src/
  index.ts      # fetch (POST /interactions: PING, commands, buttons; optional POST /tick) + scheduled (cron)
  tick.ts       # idempotent tick: slate after SLATE_HOUR ET, grading sweep, recap, pinned board
  time.ts       # ET day helpers, pure
  leagues.ts    # the league keys, icons, draw rule and the GameInfo shape every source returns
  sources/      # the data-source seam: index.ts (SportSource, sourceFor), odds-api.ts (the one shipped, metered)
  odds.ts       # moneyline -> fair probability -> payout, pure
  scoring.ts    # pointsFor (the tuning seam) + standings, pure
  store.ts      # every D1 query; the only module that knows the schema
  discord.ts    # Ed25519 verification, REST helpers with retry, interaction constants
  brand.ts      # embed colour, kept out of discord.ts so that file carries no branding
  tickroute.ts  # the optional authenticated /tick route for an external scheduler
scripts/register.mjs   # registers the slash commands to one guild (reads .dev.vars)
migrations/            # D1 migrations; 0001_init.sql is the whole schema, all IF NOT EXISTS
test/                  # vitest; store tests run the real migration on real SQLite (node:sqlite, Node 22+)
```

## Conventions

- `pointsFor()` is pure, deterministic, finite, >= 0, and only called for a correct
  pick. Tests pin that contract.
- Every interaction answers within 3 seconds; slow work is deferred into
  `ctx.waitUntil` and finishes by editing the deferred response.
- Buttons carry all their state in `custom_id` (`pick:<gameId>:<side>`,
  `forget:confirm`). No server-side view state.
- Discord snowflakes are TEXT end to end.
- The tick decides in Eastern Time from D1 state; the cron expression is UTC and
  never encodes a local hour.
- A metered source grades on GRADE_HOURS, recorded in `last_grade_slot` only after
  a sweep finishes; a source never logs its URL (the key is in the query string).
- A game with no result after VOID_AFTER_HOURS is voided, so one lost game cannot
  hold a day's recap open forever.
- `pick_events` is never UPDATEd; the only DELETE is `Store.forgetUser`.
- All Discord REST calls go through `rest()`, which honours `Retry-After` on a
  429 and backs off on 5xx. Slate posting is paced and per-game isolated.
- Secrets only via `wrangler secret put` or the deploy button's prompts;
  `wrangler.jsonc` carries no ids so one config serves every deployment.

## Commands

```
npm test · npm run check · npm run deploy (migrate, then deploy) · npm run register · npx wrangler tail
```
