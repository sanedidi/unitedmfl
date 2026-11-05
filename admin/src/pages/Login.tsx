import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Logo, LogoMark } from "@/components/Logo";

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
      setErr(e instanceof Error ? e.message : "Kirishda xato");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <div className="login-art">
        <Logo size={26} />
        <div>
          <div className="kicker">Admin panel</div>
          <h2>Liga boshqaruv paneli</h2>
          <p>Matchlar, protokollar, live-pult va kontent — bir joyda.</p>
        </div>
        <small>© United MFL · Faqat vakolatli xodimlar uchun</small>
        <span className="mark-bg"><LogoMark size={420} /></span>
      </div>
      <div className="login-form">
        <form className="stack" onSubmit={submit}>
          <Logo size={22} className="logo mobile-logo" />
          <div><h1>Kirish</h1><p className="muted" style={{ margin: "6px 0 0" }}>Admin panelga kirish uchun ma’lumotlaringizni kiriting</p></div>
          <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw">Parol</label><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="alert danger" role="alert">{err}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? "Kirilmoqda…" : "Kirish"}</button>
        </form>
      </div>
    </div>
  );
}
