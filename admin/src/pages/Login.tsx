import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Logo, LogoMark } from "@/components/Logo";

import { tx } from "@/lib/i18n";
import { LangSwitch } from "@/components/LangSwitch";
export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await login(email.trim(), password);
    } catch (e) {
      setErr(e instanceof Error ? e.message : tx("Kirishda xato"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="login-art">
        <Logo size={56} />
        <div>
          <div className="kicker">{tx("Admin panel")}</div>
          <h2>{tx("Liga boshqaruv paneli")}</h2>
          <p>{tx("Matchlar, protokollar, live-pult va kontent — bir joyda.")}</p>
        </div>
        <small>{tx("© United MFL · Faqat vakolatli xodimlar uchun")}</small>
        <span className="mark-bg"><LogoMark size={420} mono /></span>
      </div>
      <div className="login-form">
        <LangSwitch className="login-lang" />
        <form className="stack" onSubmit={submit}>
          <Logo size={44} className="logo mobile-logo" />
          <div><h1>{tx("Kirish")}</h1><p className="muted" style={{ margin: "6px 0 0" }}>{tx("Admin panelga kirish uchun ma’lumotlaringizni kiriting")}</p></div>
          <div className="field"><label htmlFor="email">{tx("Email")}</label><input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw">{tx("Parol")}</label><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="alert danger" role="alert">{err}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? tx("Kirilmoqda…") : tx("Kirish")}</button>
        </form>
      </div>
    </div>
  );
}
