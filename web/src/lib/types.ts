export type TeamRef = {
  id: number;
  name: string;
  slug: string;
  short_name?: string;
  crest_url?: string;
  colors?: string[];
};

export type Team = TeamRef & {
  group_label: string;
  group_is_provisional: boolean;
  leader: string;
  instagram: string;
  telegram: string;
};

export type Stage = { id: number; name: string; kind: string };

export type MatchStatus = "scheduled" | "live" | "halftime" | "finished" | "postponed" | "cancelled";

export type Match = {
  id: number;
  season_id: number;
  round: string;
  kickoff_at: string;
  venue: string;
  ticket_url: string;
  status: MatchStatus | string;
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
  stage: Stage | null;
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
  payload?: { slots?: Record<string, number> } | null;
};

export type LineupRow = {
  side: "home" | "away";
  player_id: number | null;
  player_name: string;
  number: number | null;
  position: string;
  role?: string;
  slot?: number | null;
  photo_url?: string;
  is_starter: boolean;
  is_captain: boolean;
};

export type LineupMeta = { side: "home" | "away"; formation: string; status: string; coach: string; assistant: string; published_at: string | null; updated_at: string };

export type Official = { id: number; side: string; role: string; name: string };

export type Video = {
  id: number;
  title: string;
  url: string;
  youtube_id: string;
  kind: string;
  match_id: number | null;
  duration_sec: number | null;
  thumbnail_url: string;
  published_at: string | null;
};

export type NewsItem = {
  slug: string;
  title: string;
  category: string;
  excerpt: string;
  cover_url: string;
  published_at: string;
  on_home?: boolean;
  tags: string[];
  body?: string;
  seo_description?: string;
  match_id?: number | null;
  updated_at?: string;
  author?: string | null;
};

export type MatchDetail = {
  match: Match;
  events: MatchEvent[];
  lineups: LineupRow[];
  lineup_meta?: LineupMeta[];
  officials: Official[];
  videos: Video[];
  news: NewsItem[];
  protocol_pdf: string | null;
  server_time: string;
};

export type StandingRow = {
  position: number;
  team_id: number;
  team: string;
  slug: string;
  group: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals_for: number;
  goals_against: number;
  goal_diff: number;
  adjustment: number;
  points: number;
  form: string[];
};

export type Standings = {
  groups: Record<string, StandingRow[]>;
  groups_provisional: boolean;
  playoff: Match[];
  rules: { win: number; draw: number; loss: number };
};

export type Leaders = {
  summary: { matches: number; goals: number; goals_per_match: number };
  team_goals: { id: number; name: string; slug: string; group_label: string; goals: number; played: number }[];
  scorers?: { player_id: number; name: string; team: string; team_slug: string; goals: number }[];
  cards?: { player_id: number; name: string; team: string; team_slug: string; yellow: number; red: number }[];
};

export type Banner = {
  id: number;
  title: string;
  badge: string;
  badge_type: string;
  event_date: string | null;
  event_time: string;
  venue: string;
  cta_label: string;
  cta_url: string;
  image_desktop: string;
  image_mobile: string;
  /** How the copy sits over the photo; older API responses may omit it. */
  layout?: HeroLayout;
  ord: number;
};

export type HeroLayout = "shade" | "panel" | "glass" | "split" | "poster";
export const HERO_LAYOUTS: HeroLayout[] = ["shade", "panel", "glass", "split", "poster"];

export type Player = {
  id: number;
  full_name: string;
  number: number | null;
  position: string;
  photo_url: string;
  team: { id: number; name: string; slug: string } | null;
};

export type PlayerDetail = {
  player: { id: number; full_name: string; number: number | null; position: string; photo_url: string; instagram: string };
  team: { id: number; name: string; slug: string } | null;
  stats: { appearances: number; goals: number; yellow: number; red: number };
  matches?: Match[];
  updated_at?: string;
};

export type TeamDetail = {
  team: Team;
  players: { id: number; full_name: string; number: number | null; position: string; photo_url: string }[];
  matches: Match[];
};

export type Product = {
  id: number;
  slug: string;
  name: string;
  category: string;
  price_uzs: number;
  sale_price_uzs: number | null;
  images: string[];
  external_url: string;
  featured: boolean;
  status: string;
  ord: number;
  description?: string;
  variants?: { id: number; label: string; sku: string; stock: number }[];
};

export type Season = {
  id: number;
  name: string;
  slug: string;
  is_active: boolean;
  teams_planned: number;
  matches_planned: number;
  stages: { id: number; name: string; kind: string; ord: number; status: string; note: string }[];
};

export type InstagramPost = {
  id: string;
  caption: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | string;
  is_reel: boolean;
  image_url: string;
  permalink: string;
  posted_at: string;
};

export type InstagramFeed = { username: string; posts: InstagramPost[] };
