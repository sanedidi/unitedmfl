import { createContext, useContext, type ReactNode } from "react";
import type { Block, Layout, MatchTime, ModuleType, Row } from "@/lib/layout";

export type Device = "desktop" | "tablet" | "mobile";
export type Sel = { kind: "block"; id: string } | { kind: "row"; id: string } | null;

export type NewsLite = { id: number; slug: string; title: string; category: string; published_at: string | null };
export type TeamLite = { id: number; name: string; slug: string; group_label: string };
export type MatchLite = MatchTime & { id: number; round: string; home: { name: string } | null; away: { name: string } | null };

/** Data the inspector needs for its pickers, loaded once by the builder. */
export type Refs = {
  matches: MatchLite[];
  news: NewsLite[];
  teams: TeamLite[];
  groups: { code: string; name: string }[];
};

export type BuilderApi = {
  layout: Layout;
  refs: Refs;
  now: number; // the moment the canvas shows (time-travel or the real now)
  device: Device;
  /** a change that goes into undo history and the autosave */
  commit: (next: Layout) => void;
  select: (s: Sel) => void;
  sel: Sel;
  toast: (t: string, kind?: "ok" | "error" | "info") => void;
  addBlock: (type: ModuleType, afterRowId?: string) => void;
};
export const BuilderCtx = createContext<BuilderApi | null>(null);
export const useBuilder = () => useContext(BuilderCtx)!;

export function Seg<T extends string | number>({ value, options, onChange, full, disabled }: {
  value: T; options: { key: T; label: ReactNode; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; full?: boolean; disabled?: boolean;
}) {
  return (
    <div className={`seg hb-seg${full ? " full" : ""}`} role="group">
      {options.map((o) => (
        <button key={String(o.key)} type="button" aria-pressed={o.key === value} disabled={disabled || o.disabled} title={o.title} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="hb-switch">
      <span className="grow"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function F({ label, value, children, hint }: { label: ReactNode; value?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="hb-f">
      <div className="hb-f-head"><span>{label}</span>{value != null && <b>{value}</b>}</div>
      {children}
      {hint && <small className="hb-hint">{hint}</small>}
    </div>
  );
}

/** Tiny icons used only by the builder (the rest come from components/Icons). */
const s = (size = 16) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true });
export const BI = {
  grip: ({ size }: { size?: number }) => <svg {...s(size)}><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></svg>,
  clock: ({ size }: { size?: number }) => <svg {...s(size)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  undo: ({ size }: { size?: number }) => <svg {...s(size)}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 010 10h-3" /></svg>,
  redo: ({ size }: { size?: number }) => <svg {...s(size)}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 000 10h3" /></svg>,
  layers: ({ size }: { size?: number }) => <svg {...s(size)}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>,
  eyeOff: ({ size }: { size?: number }) => <svg {...s(size)}><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0112 6c6 0 10 6 10 6a17 17 0 01-3.2 3.9M6.5 7.6A17 17 0 002 12s4 6 10 6a9.6 9.6 0 004.2-1" /><path d="M9.9 9.9a3 3 0 004.2 4.2" /></svg>,
  unlock: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 017.7-1.5" /></svg>,
  monitor: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  tablet: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M11 18h2" /></svg>,
  phone: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="7" y="3" width="10" height="18" rx="2" /><path d="M11 18h2" /></svg>,
  split: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="3" y="4" width="7" height="16" rx="1.5" /><rect x="14" y="4" width="7" height="16" rx="1.5" /></svg>,
  merge: ({ size }: { size?: number }) => <svg {...s(size)}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /></svg>,
  extract: ({ size }: { size?: number }) => <svg {...s(size)}><path d="M14 4h6v6M20 4l-8 8M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-4" /></svg>,
};

export type { Block, Row };
