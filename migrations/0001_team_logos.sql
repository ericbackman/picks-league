-- Add ESPN CDN team-logo URLs to the games table (per side).
-- Additive + nullable, so it's safe to apply to the live DB with existing rows
-- (they backfill to NULL = "no logo"; new slates populate it at post time).
-- Applied to the remote D1 with:
--   npx wrangler d1 execute picks --file migrations/0001_team_logos.sql --remote
ALTER TABLE games ADD COLUMN away_logo TEXT;
ALTER TABLE games ADD COLUMN home_logo TEXT;
