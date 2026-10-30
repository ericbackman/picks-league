# Contributing

Issues and pull requests are welcome. A few things that keep this repo easy to trust:

- **Tests first for logic.** Scoring, odds, time math, ESPN parsing and the store are pure modules with tests in `test/`. A change to any of them comes with a test; a bug fix comes with the test that would have caught it.
- **Keep the three-second rule.** Discord drops an interaction that takes longer than three seconds to answer. Anything slower returns a deferred response and finishes in `ctx.waitUntil`.
- **Discord ids are strings end to end.** A snowflake overflows a JavaScript number. Never parse one.
- **The tick stays idempotent.** It reads every decision from D1 and may run twice, or not at all, for any 15-minute window. Nothing in it may depend on the previous run having happened.
- **No new runtime dependencies without a reason.** The Worker has none; signature checks use WebCrypto and the Discord calls are plain `fetch`.
- **Secrets never land in `wrangler.jsonc` or a commit.** `.dev.vars` is gitignored on purpose.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`), one logical change each.

Run `npm run check` and `npm test` before opening a pull request; CI runs the same two on Node 24.

## Adding a sport

1. Add the league to `LEAGUES` and `LEAGUE_ICONS` in `src/espn.ts` (the key is the pair ESPN uses in its scoreboard URL) and to `ODDS_API_SPORTS` in `src/sources/odds-api.ts` (The Odds API's sport key), and to `DRAW_LEAGUES` if a tie is a result.
2. Add a fixture test in `test/sources.test.ts` and `test/espn.test.ts` from real responses.
3. Add it to `SPORT_BOARDS` in `src/tick.ts` if it deserves its own standings section.

## Reporting a security issue

Open an issue with no details beyond "security, please contact me" and the maintainer will reach out, or email the address on the maintainer's GitHub profile.
