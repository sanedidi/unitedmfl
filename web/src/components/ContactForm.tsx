"use client";
import { useState } from "react";

const TOPICS = [
  { v: "partnership", l: "Hamkorlik" },
  { v: "sponsorship", l: "Homiylik" },
  { v: "team", l: "Jamoa ro‘yxatdan o‘tishi" },
  { v: "tickets", l: "Chiptalar" },
  { v: "other", l: "Boshqa" },
];

export function ContactForm() {
  const [state, setState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const body = {
      name: String(fd.get("name") || ""),
      phone: String(fd.get("phone") || "").replace(/[\s()-]/g, ""),
      topic: String(fd.get("topic") || "other"),
      message: String(fd.get("message") || ""),
    };
    setState("sending");
    setErrors({});
    try {
      const res = await fetch("/api/v1/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setState("ok");
        setMsg(data.message || "Rahmat! Tez orada siz bilan bog‘lanamiz.");
        (e.target as HTMLFormElement).reset();
        return;
      }
      setErrors((data.error?.fields as Record<string, string>) || {});
      setMsg(res.status === 429 ? "Juda ko‘p so‘rov. Birozdan so‘ng urinib ko‘ring." : data.error?.message || "Xatolik yuz berdi");
      setState("error");
    } catch {
      setMsg("Tarmoq xatosi. Qayta urinib ko‘ring.");
      setState("error");
    }
  }

  return (
    <form className="stack" onSubmit={submit} noValidate style={{ gap: 18 }}>
      <div className="grid grid-2" style={{ gap: 16 }}>
        <div className="field">
          <label htmlFor="cf-name">Ismingiz</label>
          <input id="cf-name" name="name" className="input" required minLength={2} maxLength={100} autoComplete="name" aria-invalid={!!errors.name} />
          {errors.name && <span className="field-error">{errors.name}</span>}
        </div>
        <div className="field">
          <label htmlFor="cf-phone">Telefon</label>
          <input id="cf-phone" name="phone" className="input" required type="tel" inputMode="tel" placeholder="+998 90 123 45 67" autoComplete="tel" aria-invalid={!!errors.phone} />
          {errors.phone && <span className="field-error">{errors.phone}</span>}
        </div>
      </div>
      <div className="field">
        <label htmlFor="cf-topic">Mavzu</label>
        <select id="cf-topic" name="topic" className="select" defaultValue="partnership">
          {TOPICS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="cf-message">Xabar</label>
        <textarea id="cf-message" name="message" className="textarea" maxLength={2000} aria-invalid={!!errors.message} />
        {errors.message && <span className="field-error">{errors.message}</span>}
      </div>
      {state === "ok" && <div className="alert alert-ok" role="status">{msg}</div>}
      {state === "error" && <div className="alert alert-err" role="alert">{msg}</div>}
      <div>
        <button className="btn btn-primary" disabled={state === "sending"}>{state === "sending" ? "Yuborilmoqda…" : "Yuborish"}</button>
      </div>
    </form>
  );
}
