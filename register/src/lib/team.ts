// Client for the team cabinet (/api/v1/team). The team signs in with the login
// and password the league gave it; the session token is kept on this device
// (localStorage with «Eslab qolish», otherwise only for this browser tab).

import { ApiError, type ImportResult, type MedFile, type Player, type Staff } from "./api";

const BASE = "/api/v1/team";

export type CabPlayer = Player & { id?: number; has_medical: boolean; removed?: boolean };
export type CabStaff = Staff & { id?: number; removed?: boolean };
export type CabTeam = { name: string; short_name: string; crest_url: string; colors: string[]; leader: string; instagram: string; telegram: string; kit_url: string };
export type CabDoc = { team: CabTeam; players: CabPlayer[]; staff: CabStaff[] };

export type FieldChange = { field: string; label: string; before: string; after: string };
export type ChangeItem = {
  key: string;
  kind: "team" | "player" | "staff";
  op: "update" | "add" | "remove";
  title: string;
  fields: FieldChange[];
  decision?: "approved" | "rejected" | "fix";
};
export type CabCheck = { level: "error" | "warn"; key?: string; text: string };
export type ReqStatus = "draft" | "submitted" | "changes" | "approved" | "partial" | "rejected" | "withdrawn";
export type CabRequest = {
  id: number;
  number: string;
  status: ReqStatus;
  items: ChangeItem[];
  comment: string;
  submitted_at: string | null;
  decided_at: string | null;
  updated_at: string;
};
export type TeamView = {
  team: { id: number; name: string; slug: string; login: string; site_url: string };
  live: CabDoc;
  draft: CabDoc;
  items: ChangeItem[];
  checks: CabCheck[];
  request: CabRequest | null;
  last: CabRequest | null;
  editable: boolean;
  can_submit: boolean;
};

/* ---------- session ---------- */
const KEY = "umfl.team.session";
type Saved = { login: string; token: string };

export function savedSession(login?: string): Saved | null {
  for (const st of [sessionStorage, localStorage]) {
    try {
      const v = JSON.parse(st.getItem(KEY) || "null") as Saved | null;
      if (v?.token && (!login || v.login === login)) return v;
    } catch {
      /* storage unavailable */
    }
  }
  return null;
}
function saveSession(v: Saved, remember: boolean) {
  forgetSession();
  try {
    (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the session lives until the page is closed */
  }
}
export function forgetSession() {
  for (const st of [sessionStorage, localStorage]) {
    try {
      st.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}

/* ---------- requests ---------- */
let token = "";
export const setToken = (t: string) => { token = t; };

async function parse<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON (204) */
  }
  if (!res.ok) {
    const e = body?.error || {};
    const msg = e.message || (res.status >= 500 ? "Server xatosi — birozdan so‘ng urinib ko‘ring" : `Xatolik (${res.status})`);
    throw new ApiError(res.status, e.code || "error", msg, e.fields || {}, body);
  }
  return body as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
    res = await fetch(BASE + path, { method: "POST", body: fd, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, "network", "Internet aloqasi yo‘q — qayta urinib ko‘ring");
  }
  return parse<T>(res);
}

export const team = {
  account: (login: string) => call<{ name: string; crest_url: string; enabled: boolean }>("GET", `/accounts/${encodeURIComponent(login)}`),
  async login(login: string, password: string, remember: boolean) {
    const r = await call<{ token: string; team: { login: string } }>("POST", "/login", { login, password, remember });
    setToken(r.token);
    saveSession({ login: r.team.login, token: r.token }, remember);
    return r;
  },
  async logout() {
    try {
      await call("POST", "/logout", {});
    } finally {
      setToken("");
      forgetSession();
    }
  },
  me: () => call<TeamView>("GET", "/me"),
  save: (draft: CabDoc) => call<TeamView>("PUT", "/draft", { draft }),
  discard: () => call<TeamView>("DELETE", "/draft"),
  submit: () => call<TeamView>("POST", "/submit", {}),
  withdraw: () => call<TeamView>("POST", "/withdraw", {}),
  image: (kind: "logo" | "photo" | "kit", f: File) => upload<{ url: string; width: number; height: number }>("/files", f, { kind }),
  medical: (f: File) => upload<MedFile>("/files", f, { kind: "medical" }),
  importRoster: (f: File) => upload<ImportResult>("/import", f),
};

export const emptyCabPlayer = (role: Player["role"] = "player"): CabPlayer => ({
  first_name: "", last_name: "", jersey_name: "", birth_date: "", number: null, kit_size: "", workplace: "", role, photo_url: "", medical: null, has_medical: false,
});
