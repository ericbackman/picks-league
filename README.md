# picks-league

A daily sports picks league for your Discord server, with no bot process to keep alive.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ericbackman/picks-league)

Every morning it posts the day's NBA, NHL, MLB and NFL games with a button per team. Friends tap to call winners, picks lock at tip-off, finals grade themselves off the scoreboard, and a pinned standings board tracks the season. A correct pick pays its fair odds, so calling an upset is worth more than calling a favourite, and a synthetic player called **The Bookie** picks every favourite so there is always a baseline to beat.

It runs as one Cloudflare Worker with a D1 (SQLite) database. At friends-server scale that fits inside Cloudflare's free tier.

## How it works

```
Discord ── button tap / slash command ──► POST /interactions ──► Worker ──► D1
Cron (every 15 min) ──► tick: post the slate once a day, grade finals ──► Discord REST + ESPN scoreboard
```

There is no gateway connection and nothing listening. Discord delivers slash commands and button taps as signed HTTP requests; the Worker verifies the Ed25519 signature, answers within Discord's three-second window, and finishes slow work (posting a 15-game slate) in the background. A cron trigger runs an idempotent tick: every state decision ("has today's slate posted?", "which games are ungraded?") is read from D1, so any single run can fail and the next one catches up. Eastern Time decides what "today" means; the cron expression never changes with daylight saving.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/picksetup #channel [leagues]` | Manage Server | Set the picks channel and which leagues post |
| `/slate` | anyone | Post today's games now instead of waiting for the tick |
| `/leaderboard` | anyone | Create or refresh the pinned standings |
| `/mypicks` | anyone | Your picks today, visible only to you |
| `/forgetme` | anyone | Delete everything the bot stores about you, after a confirm button |

Picking is done with the buttons on each game card. Each player also gets a private DM card for the day that updates as they pick.

## Deploy

You need a Discord application and a Cloudflare account. Both are free.

### 1. Create the Discord application

1. [Discord Developer Portal](https://discord.com/developers/applications), **New Application**, give it a name.
2. On **General Information** note the **Application ID** and **Public Key**.
3. On the **Bot** tab, **Reset Token** and copy the token. It is shown once. Treat it like a password.
4. Invite the bot to your server with this link, with your Application ID filled in. The permission number is Send Messages plus Embed Links.

   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=18432`

5. Find your server's id: in Discord, **Server Settings, Widget**, or right-click the server icon with Developer Mode on.

### 2. Deploy the Worker

**With the button** at the top of this page: Cloudflare forks the repo into your GitHub account, creates the D1 database, asks for the four values above as secrets, runs the migration and deploys. Then skip to step 3.

**By hand:**

```bash
git clone https://github.com/ericbackman/picks-league && cd picks-league
npm install
npx wrangler login
npm run deploy             # creates the D1 database on first run, then applies migrations/
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put GUILD_ID
```

`wrangler deploy` prints the Worker's URL (`https://picks-league.<your-subdomain>.workers.dev`). Until the secrets are set the Worker rejects every request from Discord, which is the safe direction.

### 3. Connect them

1. Back in the Developer Portal, **General Information, Interactions Endpoint URL**: `https://<worker-url>/interactions`. Discord sends a signed ping and refuses to save the URL until the Worker answers it, so the deploy and the public key must both be in place first.
2. Register the slash commands. Copy `.dev.vars.example` to `.dev.vars` (it is gitignored), fill in the four values, then:

   ```bash
   npm run register
   ```

   Commands are registered to your server only, so they appear immediately.
3. In Discord: `/picksetup #picks`, then `/slate` to post today's games without waiting for the morning tick.

## Configuration

**Leagues** are a live setting, changed with `/picksetup`, not a redeploy. The value is whitespace-separated: `nba` takes the whole league, `mlb:TOR` only games involving that team, `mlb:TOR+NYY` several teams. Default: `nba nhl mlb nfl`. Keys: `nba`, `nhl`, `mlb`, `nfl`, `wc` (FIFA World Cup, with a Draw button). A full MLB day is about 15 games; filter it if that floods your channel.

**Team logos.** Game cards show the two teams' logos from ESPN's CDN, fetched by Discord's own image proxy. Set the `TEAM_LOGOS` variable to `off` (in `wrangler.jsonc` under `vars`, or as a secret) for text-only cards; the logo URLs are then never stored either.

**Slate time.** `SLATE_HOUR` in `src/tick.ts` (default 6, Eastern) is the earliest hour the day's slate posts.

**External scheduler.** If you would rather drive the tick from another Worker than from this one's cron trigger (the free plan allows five cron triggers per account), set a `TICK_KEY` secret and POST `/tick` with it as a bearer token. The route is inert until the secret exists.

**Standings sections.** `SPORT_BOARDS` in `src/tick.ts` lists the per-sport sections on the standings board and the daily recap. A league with no graded pick yet is omitted, so leaving a sport out of season in the list costs nothing.

## Scoring

A correct pick pays its fair decimal odds, like a one-unit bet. The moneylines ESPN publishes with each game are stripped of the bookmaker's margin into fair probabilities ([src/odds.ts](src/odds.ts)), and a winning pick scores `1 / p`, to one decimal, capped at 10, with 2.0 as the coin-flip fallback when no line exists. The card shows each side's line, win probability and payout, and the payout shown is exactly what the pick scores. Soccer's three-way market is handled.

`pointsFor()` in [src/scoring.ts](src/scoring.ts) is the tuning seam. It is pure, deterministic, finite and non-negative, and the tests pin that contract, so a cap, league weights or playoff multipliers are safe to add there.

## Data and privacy

What the bot stores, all in your own D1 database and nowhere else:

- per game: the ESPN game id, teams, start time, lines, scores, the message id of its card;
- per pick: the player's Discord user id and display name, the side, the points once graded;
- an audit log of every tap (user id, name, side, server timestamp), so a "but I picked the draw!" dispute can be settled by replaying what was tapped and when;
- the id of each player's private DM card.

`/forgetme` deletes all of it for the player who runs it, including their rows in the audit log, and refreshes the standings. Nothing is sent anywhere except Discord's API and ESPN's public scoreboard, which receives only the date and league being asked for. There is no analytics and no third-party service.

Picks here are for bragging rights. The bot holds no money, takes no bets and pays nothing out; the odds are a scoring rule, not a market.

## Known limits

- **ESPN's scoreboard API is public but undocumented.** There is no key, no terms page and no change notice. If ESPN reshapes the payload, grading stalls and the logs say which league; that is the only part of this bot that can break without a deploy. Logos are ESPN's images, shown by URL.
- **One server per deployment**, by design. The Worker ignores interactions from any other server, and slash commands are registered to that server. Running it for two servers is two deployments.
- **Everything is Eastern Time**, because that is how North American sports schedules are published. A game's "day" is its ET calendar day.
- **Free-tier numbers.** The tick makes a handful of requests every 15 minutes; a 15-game slate posts 15 messages with pacing between them. That is well under the free plan's 100,000 requests a day and 50 subrequests per invocation. D1 rows: a few hundred games and a few thousand picks per season.

## Development

```bash
npm test          # vitest; needs Node 22 or newer (the store tests run against real SQLite via node:sqlite)
npm run check     # tsc --noEmit
npx wrangler dev  # local Worker; Discord cannot reach it, so it is for the tick and /tick only
npx wrangler tail # live logs from the deployed Worker
```

Parsing, time math, scoring and the store are pure and tested; the Discord and ESPN calls are the thin shell around them. Operating a live deployment, including what each failure looks like in the logs, is in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## License

MIT. See [LICENSE](LICENSE).
