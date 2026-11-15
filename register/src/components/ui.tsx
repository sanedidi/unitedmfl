import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { I } from "./Icons";

/* ---------- toasts ---------- */
type Toast = { id: number; text: string; kind: "ok" | "error" };
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

/* ---------- modal ---------- */
export function Modal({ title, onClose, children, footer, small }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; small?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${small ? " sm" : ""}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Yopish"><I.x /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- form bits ---------- */
export function Field({ label, opt, hint, error, children }: { label: string; opt?: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}{opt && <span className="opt">{opt}</span>}</label>
      {children}
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Yuklanmoqda" />;
}
export const Loading = () => <div className="loading"><Spinner /></div>;

export function CheckLine({ level, children }: { level: "error" | "warn" | "ok"; children: ReactNode }) {
  return (
    <div className={`chk ${level}`}>
      {level === "ok" ? <I.check size={16} /> : <I.alert size={16} />}
      <div className="grow">{children}</div>
    </div>
  );
}

export const STATUS_PILL: Record<string, { tone: string; label: string }> = {
  draft: { tone: "neutral", label: "Qoralama" },
  submitted: { tone: "info", label: "Yuborildi" },
  review: { tone: "info", label: "Ko‘rib chiqilmoqda" },
  changes: { tone: "warn", label: "Tuzatish kerak" },
  approved: { tone: "ok", label: "Tasdiqlangan" },
  rejected: { tone: "danger", label: "Rad etilgan" },
};
export const Pill = ({ tone, children }: { tone: string; children: ReactNode }) => <span className={`pill ${tone}`}>{children}</span>;
