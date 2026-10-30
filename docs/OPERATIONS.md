# Operating a live deployment

What to look at when something seems off, and the few hand operations that exist. Everything here assumes the deploy in the README is done and `npx wrangler` is logged in to the account that owns the Worker. The database binding is `DB`; the examples use `npx wrangler d1 execute DB --remote`, which works once `wrangler.jsonc` carries the database id that the first deploy wrote back.

## 1. Health check

```bash
npx wrangler tail
```

Within one 15-minute window you should see either `no games on <day>` (an empty day) or slate and grading lines, with no uncaught exceptions. Silence for 15 minutes or more on a day with games is the failure signal.

```bash
npx wrangler d1 execute DB --remote --command "SELECT key, value FROM settings"
```

Expected rows: `channel_id` (set by `/picksetup`), `last_slate_day` (today's ET date once the slate has posted), `last_grade_slot` (the last scheduled sweep that completed, like `2026-10-30T06`; absent with `GRADE_HOURS=*`), `leaderboard_message_id` (once `/leaderboard` has run or the first day graded). No `channel_id` means `/picksetup` has never run on this database.

Every call to The Odds API logs a line like `odds-api /sports/basketball_nba/scores: 2 credit(s), 331 left this month`. Under 50 left, it warns.

In Discord: the picks channel shows today's cards (buttons on games that have not started, `Final:` text on graded ones) and the pinned message at the top is the standings.

## 2. What the tick does

Every 15 minutes `runTick()` in `src/tick.ts`:

1. If `last_slate_day` is not today (ET) and the ET hour is at or past `SLATE_HOUR`, asks the data source for each configured league's games and posts a card per game, pacing the posts. `last_slate_day` is only written once every game has a card, so a partial post tops itself up on the next tick.
2. If a grading sweep is due (`GRADE_HOURS`: every tick with `*`, else once per listed ET hour, recorded in `last_grade_slot` only after the sweep finishes), then for every day that still has an ungraded game: fetches that day's results, records finals, grades picks, edits each finished game's card to a compact result, and posts a recap once the whole day is graded.
3. Refreshes the pinned standings when anything graded.

A game with no result 72 hours after its start (postponed, cancelled, or dropped by the source) grades as `void`: nobody scores, the card says so.

## 3. Failure modes

| Symptom | Cause | Fix | Verified by |
|---|---|---|---|
| No slate posted for the day | `channel_id` missing, or `last_slate_day` is already today (the slate posted and was deleted by hand) | `/picksetup`; or delete the `last_slate_day` row and the next tick re-posts whatever has no card | A slate within one tick |
| `odds-api ... HTTP 401 ... OUT_OF_USAGE_CREDITS` | The month's credits are spent | Wait for the reset (the 1st), lower `GRADE_HOURS` to one sweep, drop a league, or move to a paid plan. Nothing is lost: the next sweep grades what it can still see (three days back) | The next call logs credits left |
| `odds-api ... HTTP 401 ... INVALID_KEY` or `MISSING_KEY` | The secret is wrong or unset | `npx wrangler secret put ODDS_API_KEY` | The next tick's log line |
| `ODDS_API_KEY is not set` thrown on every tick | The secret was never set | `npx wrangler secret put ODDS_API_KEY` | Ticks run clean |
| Games graded only the next morning | That is the default: `GRADE_HOURS=6` | `GRADE_HOURS="6 23"` or `*` if your quota allows (README, Grading schedule) | Finals edit at the new hours |
| A game voided that was actually played | It had no result for 72 hours: the source never reported it, or the sweep that would have was skipped (credits out, key invalid) | Regrade it by hand (section 5) once you know the score | The card shows the final |
| `fetching <league> slate` or `grading fetch` errors in the tail | The source unreachable or slow | None: the next sweep retries. Persisting for hours means the source changed something, see the next row | That league completing normally |
| Grading stuck for one league across many sweeps, no error | The source reshaped its payload; the parsers skip what they cannot read rather than guess | Compare a live response with the fixtures in `test/sources.test.ts`, update the parser, add the new fixture, deploy | The league grades on the next sweep |
| A day graded but no recap posted | The recap post failed (Discord outage, permissions). The flag `recap_<day>` is only set after a successful post, and fully graded recent days are re-swept, so it retries every tick | If it keeps failing, `tail` shows `recap <day> failed` with Discord's reply; fix the permission. To force one by hand: delete the `recap_<day>` row | The recap appears, the row reads `1` |
| A card never changed to `Final:` | The message edit failed but grading committed | Cosmetic. Points are correct in D1 and on the board | `SELECT * FROM games WHERE game_id = ...` shows `graded = 1` |
| Slash command shows old options | Commands changed without `npm run register` | `npm run register` | Discord's autocomplete shows the new shape |
| Discord refuses to save the interactions URL | Worker not deployed, wrong `DISCORD_PUBLIC_KEY`, or the secret not set yet | Set the secrets, redeploy, retry | The portal saves the URL |
| `wrangler deploy` fails with an auth error | The API token lacks Workers Scripts or D1 edit permission | Re-run `npx wrangler login`, or fix the token's scopes | Deploy succeeds |
| The tick stopped entirely | The cron trigger was removed (an empty `crons` array deploys as "no trigger") or the account is at its cron limit | Check `triggers.crons` in `wrangler.jsonc` and the Cloudflare dashboard's Triggers tab | Log lines resume on the next 15-minute boundary |

## 4. Settling a pick dispute

`pick_events` is the audit log: one row per accepted tap, server-timestamped, never updated.

```bash
npx wrangler d1 execute DB --remote --command "SELECT * FROM pick_events WHERE game_id = '<GAME_ID>' ORDER BY id"
npx wrangler d1 execute DB --remote --command "SELECT * FROM picks WHERE game_id = '<GAME_ID>' AND user_id = '<USER_ID>'"
npx wrangler d1 execute DB --remote --command "SELECT * FROM games WHERE game_id = '<GAME_ID>'"
```

`picks.side` should equal the last `pick_events` row for that game and user. If it does, the log says what was tapped and when, and the dispute is social. If the pick is right but the points are wrong, the `games` row has the wrong winner: that is a regrade, below.

## 5. Regrading a game

Only when the source's final was wrong or a game was later voided. Set the correct winner, mark the game ungraded, and let the next tick re-grade it; `pick_events` is never touched.

```bash
npx wrangler d1 execute DB --remote --command "UPDATE games SET winner = 'away', graded = 0 WHERE game_id = '<GAME_ID>'"
```

The next sweep re-fetches that day's results first. If the source still reports the wrong result, the sweep will re-apply it; in that case also set `winner` to `void` so nobody scores, which the source cannot override.

## 6. Schema changes

Migrations live in `migrations/`, numbered, and `npm run deploy` applies the new ones before deploying. Keep them additive (`ALTER TABLE ... ADD COLUMN`, nullable or with a default); SQLite's column drop is awkward and nothing here needs it. Check the result with:

```bash
npx wrangler d1 execute DB --remote --command "PRAGMA table_info(games)"
```

## 7. Tuning knobs

| Knob | Where | Default | Notes |
|---|---|---|---|
| Scoring policy | `pointsFor()` in `src/scoring.ts`, the cap in `src/odds.ts` | fair-odds payout, capped at 10 | Must stay pure, finite and non-negative; the tests check |
| Standings sections | `SPORT_BOARDS` in `src/tick.ts` | all four leagues plus World Cup | Empty leagues are omitted |
| Default leagues for a fresh `/picksetup` | `DEFAULT_LEAGUES` in `src/tick.ts` | `nba nhl mlb nfl` | The live value is the `leagues` setting |
| Slate hour (ET) | `SLATE_HOUR` in `src/tick.ts` | 6 | 0 to 23 |
| Tick cadence | `triggers.crons` in `wrangler.jsonc` | every 15 minutes | The slate and lock times depend on it; never encode an ET hour in the cron, DST is handled inside the tick |
| Grading sweeps | `GRADE_HOURS` var | `6` | ET hours, or `*` for every tick (a paid plan); each sweep costs 2 credits per league with games pending |
| Bookmaker preference | `ODDS_API_BOOKMAKERS` var | first in the response | Comma-separated keys from The Odds API's list |

## 8. Erasure on request

A player who is still in the server runs `/forgetme`. One who has left, or who asks you another way, gets the same deletion by hand. Discord's Developer Terms require you to honour such a request, and to delete stored data when Discord or the law asks.

```bash
npx wrangler d1 execute DB --remote --command "DELETE FROM picks WHERE user_id = '<USER_ID>'; DELETE FROM pick_events WHERE user_id = '<USER_ID>'; DELETE FROM dm_cards WHERE user_id = '<USER_ID>'"
```

Then `/leaderboard` in Discord to refresh the pinned standings. Names already on finished game cards and past recaps are channel history and stay unless you delete those messages yourself.

## 9. Shutting down

The Developer Terms also require deleting stored Discord data when the app stops operating.

```bash
npx wrangler d1 delete picks-league
```

```bash
npx wrangler delete
```

Then delete the application in the Discord Developer Portal. Workers logs age out on their own within a week.

## 10. Do not

- Update `pick_events` by hand. Rows are deleted only for a player's own erasure (section 8 or `/forgetme`), never edited.
- Change `games` or `picks` by hand except through the regrade recipe above: every row is a live standings number your friends can see.
- Let a Discord id become a number anywhere. They are strings end to end.
- Put `DISCORD_TOKEN` in `wrangler.jsonc`. Secrets only.
- Test in the live channel. `npm test` and `npx wrangler tail` cover it.
