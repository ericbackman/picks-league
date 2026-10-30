-- D1 schema — direct port of the original bot's picks/store.py (D1 is SQLite).
-- Apply with: npx wrangler d1 execute picks --file schema.sql --remote

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
    game_id    TEXT PRIMARY KEY,
    league     TEXT NOT NULL,
    day        TEXT NOT NULL,            -- ET calendar day, YYYY-MM-DD
    away       TEXT NOT NULL,
    home       TEXT NOT NULL,
    away_name  TEXT NOT NULL,
    home_name  TEXT NOT NULL,
    away_logo  TEXT,                     -- ESPN CDN logo URLs; NULL = no logo on the card
    home_logo  TEXT,
    start_utc  TEXT NOT NULL,
    odds       TEXT,                     -- ESPN summary line, e.g. "PIT -149"
    home_ml    INTEGER,                  -- American moneylines (DraftKings close)
    away_ml    INTEGER,
    draw_ml    INTEGER,                  -- soccer three-way market only
    message_id TEXT,
    away_score INTEGER,
    home_score INTEGER,
    winner     TEXT,                     -- home | away | void
    graded     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_games_day ON games(day);

CREATE TABLE IF NOT EXISTS picks (
    game_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    user_name TEXT NOT NULL,
    side      TEXT NOT NULL,             -- home | away | draw
    points    REAL,                      -- NULL until graded
    PRIMARY KEY (game_id, user_id)
);

-- Append-only audit log of every accepted button tap. `picks` keeps only the
-- current selection (last tap wins); this keeps the full history so a "I picked
-- the draw!" dispute can be settled by replaying exactly what was tapped, when.
-- Never UPDATEd or DELETEd. SQLite stamps created_utc server-side so the time
-- is the worker's, not a client clock.
CREATE TABLE IF NOT EXISTS pick_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    user_name   TEXT NOT NULL,
    side        TEXT NOT NULL,           -- home | away | draw
    created_utc TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pick_events_game ON pick_events(game_id);
CREATE INDEX IF NOT EXISTS idx_pick_events_user ON pick_events(user_id);

-- One always-on DM "pick card" per user per day. The bot edits this message in
-- place as picks change (and again when the day grades), so each player has a
-- private, persistent view of their selections. message_id is the card to edit;
-- dm_channel_id is cached so we don't re-open the DM channel every tap.
CREATE TABLE IF NOT EXISTS dm_cards (
    user_id       TEXT NOT NULL,
    day           TEXT NOT NULL,
    dm_channel_id TEXT NOT NULL,
    message_id    TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
);
