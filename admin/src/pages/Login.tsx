import { useState } from "react";
import { useAuth } from "@/lib/auth";

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
        <div className="row"><img src="/favicon.svg" width={44} height={44} alt="" /><b style={{ fontSize: 18 }}>United MFL</b></div>
        <h2>Liga boshqaruv paneli</h2>
        <span style={{ opacity: .6 }}>Matchlar, protokollar, live-pult va kontent — bir joyda.</span>
      </div>
      <div className="login-form">
        <form className="stack" onSubmit={submit}>
          <div><h1 style={{ fontFamily: "var(--font-display)", fontSize: 26 }}>Kirish</h1><p className="muted" style={{ margin: "6px 0 0" }}>Admin panelga kirish uchun ma’lumotlaringizni kiriting</p></div>
          <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="pw">Parol</label><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {err && <div className="alert danger" role="alert">{err}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>{busy ? "Kirilmoqda…" : "Kirish"}</button>
        </form>
      </div>
    </div>
  );
}
