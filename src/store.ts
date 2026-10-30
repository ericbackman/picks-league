// D1 persistence. D1 is SQLite; ids are TEXT because Discord snowflakes don't
// fit safely in JS numbers.

import type { GameInfo } from "./leagues";

export interface GameRow {
  game_id: string;
  league: string;
  day: string;
  away: string;
  home: string;
  away_name: string;
  home_name: string;
  start_utc: string;
  odds: string | null;
  home_ml: number | null;
  away_ml: number | null;
  draw_ml: number | null;
  message_id: string | null;
  away_score: number | null;
  home_score: number | null;
  winner: string | null;
  graded: number;
}

export interface PickRow {
  game_id: string;
  user_id: string;
  user_name: string;
  side: string;
  points: number | null;
}

export interface GradedRow {
  user_id: string;
  user_name: string;
  side: string;
  points: number | null;
  winner: string;
  league: string; // carried from games — lets standings be re-projected per sport
}

// One row per accepted button tap — append-only history behind the current pick.
export interface PickEvent {
  // No display name here on purpose: the audit log is replayed by user id, and
  // keeping every nickname a player ever had is more than a dispute needs.
  id: number;
  game_id: string;
  user_id: string;
  side: string;
  created_utc: string;
}

// The editable DM "pick card" we keep in sync for a user on a given day.
export interface DmCard {
  user_id: string;
  day: string;
  dm_channel_id: string;
  message_id: string;
}

export class Store {
  constructor(private db: D1Database) {}

  // ---------- settings ----------

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO settings(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(key, value)
      .run();
  }

  // ---------- games ----------

  async upsertGames(day: string, games: GameInfo[]): Promise<void> {
    if (!games.length) return;
    const stmt = this.db.prepare(
      "INSERT INTO games(game_id, league, day, away, home, away_name, " +
        "home_name, start_utc, odds, home_ml, away_ml, draw_ml) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(game_id) DO UPDATE SET " +
        "start_utc = excluded.start_utc, " +
        "odds = COALESCE(excluded.odds, games.odds), " +
        "home_ml = COALESCE(excluded.home_ml, games.home_ml), " +
        "away_ml = COALESCE(excluded.away_ml, games.away_ml), " +
        "draw_ml = COALESCE(excluded.draw_ml, games.draw_ml)"
    );
    await this.db.batch(
      games.map((g) =>
        stmt.bind(
          g.gameId, g.league, day, g.away, g.home, g.awayName, g.homeName,
          g.startUtc, g.odds, g.homeMl, g.awayMl, g.drawMl
        )
      )
    );
  }

  async setMessage(gameId: string, messageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE games SET message_id = ? WHERE game_id = ?")
      .bind(messageId, gameId)
      .run();
  }

  async game(gameId: string): Promise<GameRow | null> {
    return await this.db
      .prepare("SELECT * FROM games WHERE game_id = ?")
      .bind(gameId)
      .first<GameRow>();
  }

  async gamesForDay(day: string): Promise<GameRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM games WHERE day = ?")
      .bind(day)
      .all<GameRow>();
    return results;
  }

  async daysWithUngraded(): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT day FROM games WHERE graded = 0 ORDER BY day")
      .all<{ day: string }>();
    return results.map((r) => r.day);
  }

  /**
   * Days where every game is graded — the recap candidates.
   *
   * `daysWithUngraded` cannot serve this: a day drops out of it the moment its
   * last game grades. The recap flag is only set AFTER a successful post, so if
   * that post failed the day is already fully graded, never comes back round, and
   * the recap is lost permanently.
   *
   * Bounded and newest-first: a day stays fully graded forever, and we only need
   * to catch a recap that has not managed to post yet.
   */
  async daysFullyGraded(limit = 5): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        "SELECT day FROM games GROUP BY day " +
          "HAVING SUM(CASE WHEN graded = 0 THEN 1 ELSE 0 END) = 0 " +
          "ORDER BY day DESC LIMIT ?"
      )
      .bind(limit)
      .all<{ day: string }>();
    return results.map((r) => r.day);
  }

  /**
   * Leagues on a day with an ungraded game that has already started by `nowIso`.
   * A league whose games are all still ahead has nothing to grade, and asking the
   * source anyway spends credits for nothing (the morning tick posts the slate
   * and then grades in the same run).
   */
  async ungradedLeagues(day: string, nowIso: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT league FROM games WHERE day = ? AND graded = 0 AND start_utc <= ?")
      .bind(day, nowIso)
      .all<{ league: string }>();
    return results.map((r) => r.league);
  }

  async applyResult(info: GameInfo): Promise<void> {
    // Also backfill moneylines (rows stored before per-side odds existed get
    // them here, just in time for grading).
    await this.db
      .prepare(
        "UPDATE games SET away_score = ?, home_score = ?, winner = ?, " +
          "home_ml = COALESCE(home_ml, ?), away_ml = COALESCE(away_ml, ?), " +
          "draw_ml = COALESCE(draw_ml, ?) " +
          "WHERE game_id = ? AND graded = 0"
      )
      .bind(
        info.awayScore, info.homeScore, info.winner,
        info.homeMl, info.awayMl, info.drawMl, info.gameId
      )
      .run();
  }

  /**
   * Void every game on a day that started before `cutoffIso` and still has no
   * result. Returns how many. The next ungradedFinals() pass grades them for
   * nobody and edits their cards to "no contest".
   */
  async voidStale(day: string, cutoffIso: string): Promise<number> {
    const result = await this.db
      .prepare("UPDATE games SET winner = 'void' WHERE day = ? AND graded = 0 AND winner IS NULL AND start_utc < ?")
      .bind(day, cutoffIso)
      .run();
    return result.meta.changes;
  }

  async ungradedFinals(day: string): Promise<GameRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM games WHERE day = ? AND graded = 0 AND winner IS NOT NULL")
      .bind(day)
      .all<GameRow>();
    return results;
  }

  async countUngraded(day: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM games WHERE day = ? AND graded = 0")
      .bind(day)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async gradeGame(gameId: string, pointsByUser: Map<string, number>): Promise<void> {
    const updates = [...pointsByUser.entries()].map(([userId, points]) =>
      this.db
        .prepare("UPDATE picks SET points = ? WHERE game_id = ? AND user_id = ?")
        .bind(points, gameId, userId)
    );
    updates.push(this.db.prepare("UPDATE games SET graded = 1 WHERE game_id = ?").bind(gameId));
    await this.db.batch(updates);
  }

  // ---------- picks ----------

  async recordPick(gameId: string, userId: string, userName: string, side: string): Promise<void> {
    // Two writes, one batch (atomic in D1): update the current pick, and append
    // an immutable audit event. `picks` is last-tap-wins, so it forgets history;
    // `pick_events` remembers every tap to settle "I picked the draw!" disputes.
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO picks(game_id, user_id, user_name, side) VALUES(?,?,?,?) " +
            "ON CONFLICT(game_id, user_id) DO UPDATE SET " +
            "side = excluded.side, user_name = excluded.user_name"
        )
        .bind(gameId, userId, userName, side),
      this.db
        .prepare("INSERT INTO pick_events(game_id, user_id, side) VALUES(?,?,?)")
        .bind(gameId, userId, side),
    ]);
  }

  /**
   * Delete everything stored about one user: current picks, every tap in the
   * audit log, and their DM cards. This is the ONE path that deletes from
   * pick_events (the /forgetme command). Graded games and other players' rows
   * are untouched; the standings simply stop counting this player. Returns how
   * many current picks were removed.
   */
  async forgetUser(userId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS n FROM picks WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    await this.db.batch([
      this.db.prepare("DELETE FROM picks WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM pick_events WHERE user_id = ?").bind(userId),
      this.db.prepare("DELETE FROM dm_cards WHERE user_id = ?").bind(userId),
    ]);
    return row?.n ?? 0;
  }

  // Full tap history for a game, oldest first — the audit trail for disputes.
  async pickHistory(gameId: string): Promise<PickEvent[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM pick_events WHERE game_id = ? ORDER BY id")
      .bind(gameId)
      .all<PickEvent>();
    return results;
  }

  async picksForGame(gameId: string): Promise<PickRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM picks WHERE game_id = ?")
      .bind(gameId)
      .all<PickRow>();
    return results;
  }

  async picksForUserDay(userId: string, day: string): Promise<(PickRow & GameRow)[]> {
    const { results } = await this.db
      .prepare(
        "SELECT p.side, p.points, g.* FROM picks p JOIN games g USING(game_id) " +
          "WHERE p.user_id = ? AND g.day = ? ORDER BY g.start_utc"
      )
      .bind(userId, day)
      .all<PickRow & GameRow>();
    return results;
  }

  // Graded picks joined with their games — feed for scoring.standings().
  async gradedRows(day?: string): Promise<GradedRow[]> {
    let query =
      "SELECT p.user_id, p.user_name, p.side, p.points, g.winner, g.league " +
      "FROM picks p JOIN games g USING(game_id) WHERE g.graded = 1";
    let stmt = this.db.prepare(day ? query + " AND g.day = ?" : query);
    if (day) stmt = stmt.bind(day);
    const { results } = await stmt.all<GradedRow>();
    return results;
  }

  // Graded picks in chronological order (by kickoff) — feed for streak math,
  // which needs the sequence, not just the totals. Voided games are excluded so
  // a no-contest doesn't break a streak.
  async gradedRowsChrono(): Promise<GradedRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT p.user_id, p.user_name, p.side, p.points, g.winner, g.league " +
          "FROM picks p JOIN games g USING(game_id) " +
          "WHERE g.graded = 1 AND g.winner != 'void' ORDER BY g.start_utc"
      )
      .all<GradedRow>();
    return results;
  }

  // ---------- DM pick cards ----------

  /** Every DM card a user has, so /forgetme can delete the messages themselves. */
  async dmCardsForUser(userId: string): Promise<DmCard[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM dm_cards WHERE user_id = ?")
      .bind(userId)
      .all<DmCard>();
    return results;
  }

  async getDmCard(userId: string, day: string): Promise<DmCard | null> {
    return await this.db
      .prepare("SELECT * FROM dm_cards WHERE user_id = ? AND day = ?")
      .bind(userId, day)
      .first<DmCard>();
  }

  /**
   * Atomically reserve the one-card-per-user-per-day slot before we post a DM.
   * Returns true only for the caller that actually inserted the row; concurrent
   * taps get false and must NOT post a second DM. message_id starts empty and is
   * filled by finalizeDmCard once the message exists.
   */
  async claimDmCard(userId: string, day: string, dmChannelId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "INSERT INTO dm_cards(user_id, day, dm_channel_id, message_id) VALUES(?,?,?,'') " +
          "ON CONFLICT(user_id, day) DO NOTHING"
      )
      .bind(userId, day, dmChannelId)
      .run();
    return result.meta.changes === 1;
  }

  async finalizeDmCard(userId: string, day: string, messageId: string): Promise<void> {
    await this.db
      .prepare("UPDATE dm_cards SET message_id = ? WHERE user_id = ? AND day = ?")
      .bind(messageId, userId, day)
      .run();
  }

  // Release a claim whose DM never sent (e.g. user has DMs closed) so we don't
  // leave a dead placeholder — and never retry-spam a delivery that can't land.
  async clearDmCard(userId: string, day: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM dm_cards WHERE user_id = ? AND day = ?")
      .bind(userId, day)
      .run();
  }

  // Only real, posted cards (message_id filled) — skips in-flight/failed claims.
  async dmCardsForDay(day: string): Promise<DmCard[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM dm_cards WHERE day = ? AND message_id != ''")
      .bind(day)
      .all<DmCard>();
    return results;
  }
}
