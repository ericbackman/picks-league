# picks-league

A daily sports picks league for your Discord server, with no bot process to keep alive.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ericbackman/picks-league)

Every morning it posts the day's NBA, NHL, MLB and NFL games with a button per team. Friends tap to call winners, picks lock at tip-off, finals grade themselves off the scoreboard, and a pinned standings board tracks the season. A correct pick scores its fair odds, so calling an upset is worth more than calling a favourite, and a synthetic player called **The Bookie** picks every favourite so there is always a baseline to beat.

This is a points game. The bot holds no money, takes no bets and pays nothing out; the betting lines are shown only to set each pick's score. Do not add a prize, pot or entry fee: that turns it into a betting pool, which is regulated wherever you live.

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

1. [Discord Developer Portal](https://discord.com/developers/applications), **New Application**, give it a name. Discord's brand rules say the name may not contain "Discord".
2. On **General Information** note the **Application ID** and **Public Key**.
3. On the **Bot** tab, **Reset Token** and copy the token. It is shown once. Treat it like a password.
4. Invite the bot to your server with this link, with your Application ID filled in. The permission number is Send Messages plus Embed Links.

   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=18432`

5. Find your server's id: in Discord, **Server Settings, Widget**, or right-click the server icon with Developer Mode on.
6. Discord's Developer Terms require every app to have a privacy policy. Fill in the two placeholders in [PRIVACY.example.md](PRIVACY.example.md), commit it to your fork, and paste the file's URL into **General Information, Privacy Policy URL**.

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

**Team logos** are off by default: cards are text. Setting the `TEAM_LOGOS` variable to `on` (in `wrangler.jsonc` under `vars`, or as a secret) adds the two teams' logos, which are the leagues' and clubs' marks and artwork, hosted on ESPN's CDN and fetched by Discord's image proxy. Whether to show them is your choice as the operator; the bot holds no licence for them.

**Slate time.** `SLATE_HOUR` in `src/tick.ts` (default 6, Eastern) is the earliest hour the day's slate posts.

**External scheduler.** If you would rather drive the tick from another Worker than from this one's cron trigger (the free plan allows five cron triggers per account), set a `TICK_KEY` secret and POST `/tick` with it as a bearer token. The route is inert until the secret exists.

**Standings sections.** `SPORT_BOARDS` in `src/tick.ts` lists the per-sport sections on the standings board and the daily recap. A league with no graded pick yet is omitted, so leaving a sport out of season in the list costs nothing.

## Scoring

A correct pick scores its fair decimal odds, the way a one-unit bet would pay. The moneylines ESPN publishes with each game are stripped of the bookmaker's margin into fair probabilities ([src/odds.ts](src/odds.ts)), and a winning pick scores `1 / p`, to one decimal, capped at 10, with 2.0 as the coin-flip fallback when no line exists. The card shows each side's line, win probability and score, and the number shown is exactly what the pick scores. Soccer's three-way market is handled.

`pointsFor()` in [src/scoring.ts](src/scoring.ts) is the tuning seam. It is pure, deterministic, finite and non-negative, and the tests pin that contract, so a cap, league weights or playoff multipliers are safe to add there.

## Data and privacy

What the bot stores, in your own D1 database:

- per game: the ESPN game id, teams, start time, lines, scores, the message id of its card;
- per pick: the player's Discord user id and display name, the side, the points once graded;
- an audit log of every tap (user id, side, server timestamp; no name), so a "but I picked the draw!" dispute can be settled by replaying what was tapped and when;
- the id of each player's private DM card.

Discord also holds what the bot posts: display names on the standings, recaps and finished game cards in your channel, and each player's pick card in their DMs. Your Cloudflare Workers logs keep error lines for a few days (3 on the free plan, 7 on paid); the bot writes no names or ids into them. ESPN receives only the date and league being asked for. No analytics and no service beyond Discord, ESPN's scoreboard and Cloudflare itself.

Data is kept until a player runs `/forgetme` or you delete the database. `/forgetme` deletes the player's picks, audit-log rows and DM pick cards (the messages too) and refreshes the standings; names already on finished game cards and past recaps stay, like any channel history. A player who has left the server asks you, and [docs/OPERATIONS.md](docs/OPERATIONS.md) has the recipe. [PRIVACY.example.md](PRIVACY.example.md) says all of this in a form you can publish.

If you run this for a business, a monetised community or a large public server rather than a group of friends, the household exemptions in privacy law may not cover you. Get real advice.

## Known limits

- **ESPN's scoreboard endpoint is public but undocumented, and ESPN's terms are not permissive.** There is no key and no change notice, so if ESPN reshapes the payload, grading stalls and the logs say which league. More important: espn.com is covered by the [Disney Terms of Use](https://disneytermsofuse.com/english/), which grant personal, non-commercial use only and bar automated access. Whether those terms reach this endpoint is not settled anywhere public. Each deployment makes these calls under its operator's own responsibility; keep it private and non-commercial, and do not build a business on it.
- **One server per deployment**, by design. With `GUILD_ID` set, the Worker ignores interactions from any other server, and slash commands are registered to that server only. Running it for two servers is two deployments.
- **Everything is Eastern Time**, because that is how North American sports schedules are published. A game's "day" is its ET calendar day.
- **Free-tier numbers.** The tick makes a handful of requests every 15 minutes, and each game card is one message with pacing between them. That is well under the free plan's 100,000 requests a day. A busy spring day with three leagues can pass the 50 subrequests one invocation may make; the rest post on the next tick. D1 holds a few thousand games and tens of thousands of picks a season with all four leagues, far under its 500 MB.

picks-league is an independent project, not affiliated with or endorsed by Discord, ESPN, Cloudflare, the NBA, NHL, MLB, NFL, FIFA or any team. Team names and logos belong to their owners.

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
