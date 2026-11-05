// Thin client for the Go API with JWT access tokens and rotating refresh tokens.

const BASE = "/api/v1";
const KEY = "umfl.auth";

export type User = { id: number; name: string; email: string; role: string; permissions: string[] };
type Session = { access_token: string; refresh_token: string; expires_at: string };

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  data: unknown;
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}, data?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.data = data;
  }
}

let session: Session | null = load();
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function load(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function save(s: Session | null) {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep the session in memory only */
  }
}

export const hasSession = () => !!session;
export function onLogout(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function refresh(): Promise<boolean> {
  if (!session?.refresh_token) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: session!.refresh_token }),
        });
        if (!res.ok) return false;
        const d = await res.json();
        save({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at });
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

function expireSession() {
  save(null);
  listeners.forEach((fn) => fn());
}

async function parseError(res: Response): Promise<ApiError> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const e = body?.error || {};
  const msg = e.message || (res.status === 403 ? "Bu amal uchun ruxsat yo‘q" : res.status >= 500 ? "Server xatosi" : `Xatolik (${res.status})`);
  return new ApiError(res.status, e.code || "error", msg, e.fields || {}, body);
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const doFetch = () => {
    const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
    if (session) headers.Authorization = `Bearer ${session.access_token}`;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return fetch(`${BASE}${path}`, { method, headers, body: payload });
  };
  let res = await doFetch();
  if (res.status === 401 && session) {
    if (await refresh()) res = await doFetch();
    if (res.status === 401) {
      expireSession();
      throw new ApiError(401, "unauthorized", "Sessiya tugadi, qayta kiring");
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("Content-Type") || "";
  return (ct.includes("json") ? await res.json() : await res.text()) as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown, h?: Record<string, string>) => request<T>("POST", p, b, h),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b),
  del: <T>(p: string) => request<T>("DELETE", p),
};

/** Downloads an authenticated file (e.g. an uploaded protocol) as an object URL. */
export async function blobUrl(path: string): Promise<string> {
  const go = () => fetch(`${BASE}${path}`, { headers: session ? { Authorization: `Bearer ${session.access_token}` } : {} });
  let res = await go();
  if (res.status === 401 && (await refresh())) res = await go();
  if (!res.ok) throw await parseError(res);
  return URL.createObjectURL(await res.blob());
}

export async function login(email: string, password: string): Promise<User> {
  const res = await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw await parseError(res);
  const d = await res.json();
  save({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at });
  return api.get<User>("/admin/me");
}

export async function logout() {
  const rt = session?.refresh_token;
  save(null);
  if (rt) {
    try {
      await fetch(`${BASE}/auth/logout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: rt }) });
    } catch {
      /* ignore */
    }
  }
}

export async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await request<{ url: string }>("POST", "/admin/uploads", fd);
  return r.url;
}

export type Page<T> = { items: T[]; total: number };
