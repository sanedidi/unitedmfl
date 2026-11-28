import { lang, tx } from "@/lib/i18n";
// Client for the public registration API (/api/v1/register). There are no
// accounts: the application token in the URL is the representative's key.

const BASE = "/api/v1/register";

export type LinkState = "open" | "paused" | "soon" | "closed" | "full" | "used";

export type PublicLink = {
  code: string;
  kind: "multi" | "single";
  state: LinkState;
  heading: string;
  description: string;
  rules_url: string;
  season: string;
  stage: string;
  opens_at: string | null;
  closes_at: string | null;
  max_teams: number | null;
  slots_left: number | null;
  requirements: { min_players: number; max_players: number; min_age: number | null; logo: boolean; photo: boolean; medical: boolean; phone: boolean };
};

export type MedFile = { file: string; name: string };
export type Role = "player" | "goalkeeper" | "media";
export type Player = {
  first_name: string;
  last_name: string;
  jersey_name: string;
  birth_date: string;
  number: string | null;
  kit_size: string;
  workplace: string;
  role: Role;
  photo_url: string;
  medical: MedFile | null;
};
export type Staff = { first_name: string; last_name: string; birth_date: string; kit_size: string; role: string; phone: string };
export type Team = { name: string; short_name: string; city: string; colors: string[]; crest_url: string; crest_w: number; crest_h: number; about: string; instagram: string };
export type Rep = { name: string; role: string; phone: string; telegram: string; email: string; authorized: boolean };
export type Consents = { rules: boolean; players: boolean; personal: boolean };
export type Check = { level: "error" | "warn"; section: "team" | "rep" | "roster" | "submit"; code: string; text: string; index?: number; staff?: boolean };
export type Section = "team" | "rep" | "roster";

export type Application = {
  token: string;
  number: string;
  status: "draft" | "submitted" | "review" | "changes" | "approved" | "rejected";
  link: PublicLink | null;
  team: Team;
  rep: Rep;
  players: Player[];
  staff: Staff[];
  consents: Consents;
  phone_verified: boolean;
  otp_required: boolean;
  comments: { section: Section; text: string }[];
  changes_deadline: string | null;
  reject_reason: string;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  editable: Record<Section, boolean>;
  can_submit: boolean;
  checks: Check[];
  team_url: string;
};

export type ImportResult = {
  import: { players: Player[]; staff: Staff[]; fixes: string[]; issues: string[]; rows: number };
  logo?: { url: string; width: number; height: number };
};

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  body: any;
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}, body?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.body = body;
  }
}

async function parse<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const e = body?.error || {};
    const msg = e.message || (res.status === 404 ? tx("Topilmadi") : res.status >= 500 ? tx("Server xatosi — birozdan so‘ng urinib ko‘ring") : tx("Xatolik ({0})", res.status));
    throw new ApiError(res.status, e.code || "error", msg, e.fields || {}, body);
  }
  return body as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? { Accept: "application/json", "X-Lang": lang } : { Accept: "application/json", "Content-Type": "application/json", "X-Lang": lang },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Internet aloqasi yo‘q — qayta urinib ko‘ring");
  }
  return parse<T>(res);
}

async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", file);
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: "POST", body: fd, headers: { "X-Lang": lang } });
  } catch {
    throw new ApiError(0, "network", "Internet aloqasi yo‘q — qayta urinib ko‘ring");
  }
  return parse<T>(res);
}

const app = (token: string) => `/applications/${encodeURIComponent(token)}`;

export const api = {
  home: () => call<{ link: PublicLink | null }>("GET", "/home"),
  link: (code: string) => call<PublicLink>("GET", `/links/${encodeURIComponent(code)}`),
  create: (code: string) => call<Application>("POST", `/links/${encodeURIComponent(code)}/applications`, {}),
  get: (token: string) => call<Application>("GET", app(token)),
  save: (token: string, doc: Partial<Pick<Application, "team" | "rep" | "players" | "staff" | "consents">>) => call<Application>("PUT", app(token), doc),
  sendCode: (token: string, phone: string) => call<{ sent_to: string; retry_after: number; dev_code?: string }>("POST", `${app(token)}/otp/send`, { phone }),
  verifyCode: (token: string, code: string) => call<Application>("POST", `${app(token)}/otp/verify`, { code }),
  uploadImage: (token: string, kind: "logo" | "photo", file: File) => upload<{ url: string; width: number; height: number }>(`${app(token)}/files`, file, { kind }),
  uploadMedical: (token: string, file: File) => upload<MedFile>(`${app(token)}/files`, file, { kind: "medical" }),
  importRoster: (token: string, file: File) => upload<ImportResult>(`${app(token)}/import`, file),
  submit: (token: string) => call<Application>("POST", `${app(token)}/submit`, {}),
  fileUrl: (token: string, file: string) => tx("{0}{1}/files/{2}", BASE, app(token), encodeURIComponent(file)),
  templateUrl: `${BASE}/template.xlsx`,
};

/** Drafts started on this device, by link code — «continue where you stopped». */
const DRAFTS = "umfl.register.drafts";
export function rememberDraft(code: string, token: string) {
  try {
    const m = JSON.parse(localStorage.getItem(DRAFTS) || "{}");
    m[code] = token;
    localStorage.setItem(DRAFTS, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}
export function savedDraft(code: string): string | null {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS) || "{}")[code] || null;
  } catch {
    return null;
  }
}
export function forgetDraft(code: string) {
  try {
    const m = JSON.parse(localStorage.getItem(DRAFTS) || "{}");
    delete m[code];
    localStorage.setItem(DRAFTS, JSON.stringify(m));
  } catch {
    /* storage unavailable */
  }
}
