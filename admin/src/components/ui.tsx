import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { I } from "./Icons";
import { initials, teamColor } from "@/lib/format";
import { uploadImage } from "@/lib/api";

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; kind: "ok" | "error" | "info" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, kind }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Modal / Drawer ---------- */
function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}
export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEsc(onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Yopish"><I.x /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEsc(onClose);
  return (
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Yopish"><I.x /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </aside>
    </div>
  );
}

/* ---------- Confirm ---------- */
type ConfirmOpts = { title: string; text?: string; ok?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} footer={<>
          <button className="btn" onClick={() => close(false)}>Bekor qilish</button>
          <button className={`btn ${state.danger ? "btn-danger" : "btn-primary"}`} onClick={() => close(true)} autoFocus>{state.ok || "Tasdiqlash"}</button>
        </>}>
          {state.text && <p className="sec" style={{ margin: 0 }}>{state.text}</p>}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ---------- Bits ---------- */
export function Crest({ team, size = 28 }: { team: { id: number; name: string; short_name?: string; crest_url?: string; colors?: string[] } | null | undefined; size?: number }) {
  if (!team) return <span className="crest" style={{ width: size, height: size, background: "#cbd1da", fontSize: size * 0.36 }}>?</span>;
  return (
    <span className="crest" style={{ width: size, height: size, background: teamColor(team), fontSize: Math.max(9, size * 0.32) }}>
      {team.crest_url ? <img src={team.crest_url} alt="" /> : initials(team.name, team.short_name)}
    </span>
  );
}
export const Badge = ({ tone = "", children, plain }: { tone?: string; children: ReactNode; plain?: boolean }) => <span className={`badge ${tone}${plain ? " plain" : ""}`}>{children}</span>;
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{text && <div>{text}</div>}{action && <div style={{ marginTop: 16 }}>{action}</div>}</div>;
}
export const Loading = () => <div className="empty">Yuklanmoqda…</div>;
export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="alert danger" role="alert">
      <I.alert size={16} />
      <div className="grow">{error instanceof Error ? error.message : String(error)}</div>
      {retry && <button className="btn btn-sm" onClick={retry}>Qayta</button>}
    </div>
  );
}

export function Field({ label, error, hint, children, full }: { label?: string; error?: string; hint?: string; children: ReactNode; full?: boolean }) {
  return (
    <div className={`field${full ? " full" : ""}`}>
      {label && <label>{label}</label>}
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function ImageInput({ value, onChange, wide }: { value: string; onChange: (v: string) => void; wide?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function pick(f?: File) {
    if (!f) return;
    setBusy(true);
    try {
      onChange(await uploadImage(f));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Yuklashda xato", "error");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <div className="img-field">
      <div className={`img-preview${wide ? " wide" : ""}`} style={value ? { backgroundImage: `url("${value}")` } : undefined}>{!value && "Rasm yo‘q"}</div>
      <div className="stack grow" style={{ gap: 8 }}>
        <input className="input input-sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder="https://… yoki faylni yuklang" />
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => ref.current?.click()} disabled={busy}><I.upload size={15} /> {busy ? "Yuklanmoqda…" : "Yuklash"}</button>
          {value && <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange("")}>Olib tashlash</button>}
        </div>
      </div>
      <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}

export function Pager({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
      <span className="muted small">Jami: {total}</span>
      <div className="row">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>←</button>
        <span className="small">{page} / {pages}</span>
        <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>→</button>
      </div>
    </div>
  );
}
