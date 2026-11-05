import "server-only";

const BASE = (process.env.API_INTERNAL_URL || "http://localhost:8080").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Server-side fetch against the Go API. Every request is rendered on demand (SSR). */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    throw new ApiError(res.status, `API ${res.status} ${path}`);
  }
  return (await res.json()) as T;
}

/** Same as api(), but returns null on 404 so pages can call notFound(). */
export async function apiOrNull<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Never let one failing block break the whole page: fall back to a default. */
export async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    // Let Next.js control-flow errors (dynamic bailout, notFound, redirect) through.
    if (e && typeof e === "object" && "digest" in e) throw e;
    console.error(e);
    return fallback;
  }
}
