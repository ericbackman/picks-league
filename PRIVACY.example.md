# Privacy notice for this picks league

Fill in the two placeholders, commit this file to your fork, and paste its URL into the Discord Developer Portal under **General Information, Privacy Policy URL**. Discord's Developer Terms require every app to have one.

**Operator:** `<your name or Discord handle>`. Contact: `<a Discord handle, email or GitHub issues page>`.

## What the bot stores

When you tap a team on a game card, the bot stores, in a database the operator controls on Cloudflare D1:

- your Discord user id and display name, the game, the side you picked, and the points once the game grades;
- an audit log of every tap: user id, side and a server timestamp, so a disputed pick can be replayed;
- the id of the private pick card the bot sends to your DMs each day you pick.

It reads nothing else from Discord: no roles, avatar, messages or join date.

## Where it goes

- **The operator's Cloudflare D1 database**, encrypted at rest by Cloudflare.
- **This Discord server:** the standings board, daily recaps and finished game cards show display names and results. They are ordinary channel messages.
- **Your DMs:** your daily pick card.
- **Cloudflare Workers logs:** the operator's logs keep error lines for a few days (3 on the free plan, 7 on paid). They contain no names and no Discord ids by design: the bot redacts ids from the errors it logs.
- **The Odds API** (the-odds-api.com, operated in Australia): the bot asks it for each day's games, lines and scores. It sends only the sport and a date range, never anything about you; your device never contacts it.

No analytics, no advertising, no other service.

## How long

Until you delete it or the operator deletes the database. There is no automatic expiry.

## Deleting your data

Run `/forgetme` in the server and confirm. It deletes your picks, your audit-log rows and your DM pick cards, and refreshes the standings. Your name stays on finished game cards and past recaps already posted in the channel, like any other message history.

If you have left the server, contact the operator above; they can run the same deletion by hand.

## Age

Discord requires users to be 13 or older, or older where local law says so. This league stores nothing beyond the fields above for any player.

## Changes

The operator will update this file and its URL in the Developer Portal if any of the above changes.
