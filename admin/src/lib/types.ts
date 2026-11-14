export type TeamRef = { id: number; name: string; slug: string; short_name?: string; crest_url?: string; colors?: string[] };
export type Stage = { id: number; season_id: number; name: string; kind: string; ord: number; status: string; note: string };
export type Season = { id: number; name: string; slug: string; is_active: boolean; teams_planned: number | null; matches_planned: number | null };

export type Match = {
  id: number;
  season_id: number;
  round: string;
  kickoff_at: string | null;
  venue: string;
  ticket_url: string;
  status: string;
  period: string;
  clock_started_at: string | null;
  clock_offset_sec: number;
  home_score: number | null;
  away_score: number | null;
  home_ht: number | null;
  away_ht: number | null;
  home_et: number | null;
  away_et: number | null;
  home_pen: number | null;
  away_pen: number | null;
  attendance: number | null;
  banner_url: string;
  video_url: string;
  show_in_hero: boolean;
  published?: boolean;
  stage: { id: number; name: string; kind: string } | null;
  home: TeamRef | null;
  away: TeamRef | null;
};

export type MatchEvent = {
  id: number;
  side: "home" | "away";
  type: string;
  minute: number;
  extra_minute: number;
  player_id: number | null;
  player_name: string;
  related_player_id: number | null;
  related_player_name: string;
  note: string;
  source?: string;
  payload?: { slots?: Record<string, number> } | null;
};

export type LineupRow = { side: "home" | "away"; player_id: number | null; player_name: string; number: number | null; position: string; role?: string; slot?: number | null; photo_url?: string; is_starter: boolean; is_captain: boolean };
export type LineupMetaRow = { side: "home" | "away"; formation: string; status: "draft" | "published"; coach: string; assistant: string; published_at: string | null; updated_at: string };

export type MatchDetail = {
  match: Match;
  events: MatchEvent[];
  lineups: LineupRow[];
  lineup_meta?: LineupMetaRow[];
  officials: { id: number; side: string; role: string; name: string }[];
  protocol_pdf: string | null;
  server_time: string;
  row?: MatchRow;
};

export type MatchRow = {
  id: number; season_id: number; stage_id: number | null; round: string; home_team_id: number | null; away_team_id: number | null;
  kickoff_at: string | null; venue: string; ticket_url: string; status: string; home_score: number | null; away_score: number | null;
  home_ht: number | null; away_ht: number | null; home_et: number | null; away_et: number | null; home_pen: number | null; away_pen: number | null;
  attendance: number | null; added_time_1h: number | null; added_time_2h: number | null; banner_url: string; video_url: string; notes: string;
  published: boolean; show_in_hero: boolean;
};

export type Team = { id: number; slug: string; name: string; short_name: string; group_label: string; group_is_provisional: boolean; crest_url: string; colors: string[]; leader: string; instagram: string; telegram: string; is_active: boolean; kit_url?: string; kit_has_number?: boolean };
export type Player = { id: number; team_id: number | null; full_name: string; number: number | null; position: string; photo_url: string; instagram: string; is_active: boolean };

export type ProtoEvent = { side: "home" | "away"; type: string; minute: number; extra: number; raw?: string; number?: number; player?: string; related?: string; related_number?: number; uncertain?: boolean };
export type ProtoPlayer = { side: "home" | "away"; number: number | null; name: string; position: string; starter: boolean; captain: boolean; g?: string; s?: string; q?: string; a?: string };
export type Extracted = {
  tournament?: string; stage?: string; date?: string; time?: string; venue?: string; attendance?: number | null;
  added_time_1h?: number | null; added_time_2h?: number | null;
  home: { name: string; half1?: number | null; half2?: number | null; extra?: number | null; penalty?: number | null; total?: number | null };
  away: { name: string; half1?: number | null; half2?: number | null; extra?: number | null; penalty?: number | null; total?: number | null };
  players: ProtoPlayer[]; events: ProtoEvent[];
  officials: { role: string; name: string }[]; team_officials: { side: string; role: string; name: string }[];
  shootout_marks?: string[]; has_lineup_sheet?: boolean; has_report_sheet?: boolean;
};
export type Issue = { ref: string; code: string; message: string; severity: "error" | "warning" | "info" };
export type Protocol = {
  id: number; file_name: string; mime: string; size_bytes: number; pages: number; status: string; progress: number; method: string;
  match_id: number | null; error: string; created_at: string; applied_at: string | null; extracted?: Extracted | null; issues?: Issue[] | null; publish_pdf?: boolean;
  issues_count?: number; problems_count?: number; tournament?: string; stage?: string; date?: string; home_name?: string; away_name?: string; uploaded_by_name?: string;
};
