// The leagues the bot knows, and the one shape every data source returns a game
// in. A source (src/sources/) maps these keys to its own identifiers.

/** League key -> display name. The keys are what `/picksetup leagues` accepts. */
export const LEAGUES: Record<string, string> = {
  nba: "NBA",
  nhl: "NHL",
  mlb: "MLB",
  nfl: "NFL",
  wc: "FIFA World Cup",
};

export const LEAGUE_ICONS: Record<string, string> = {
  nba: "🏀",
  nhl: "🏒",
  mlb: "⚾",
  nfl: "🏈",
  wc: "⚽",
};

// Leagues where a finished game can legitimately end level: gets a Draw
// button, and an even final scores winner="draw" instead of "void".
export const DRAW_LEAGUES = new Set(["wc"]);

export interface GameInfo {
  gameId: string; // the source's own id, opaque, TEXT end to end
  league: string;
  startUtc: string; // ISO 8601
  away: string; // the button label: an abbreviation if the source has one, else the name
  home: string;
  awayName: string; // the display name used in message text
  homeName: string;
  state: string; // pre | in | post
  completed: boolean;
  awayScore: number | null;
  homeScore: number | null;
  winner: string | null; // home | away | draw (draw-capable leagues) | void (no result)
  odds: string | null; // an optional one-line summary a source may provide
  homeMl: number | null; // American moneylines
  awayMl: number | null;
  drawMl: number | null; // three-way markets only
}
