import { LANGS, lang, setLang } from "@/lib/i18n";

/** UZ / RU switcher. The choice is kept in localStorage; switching reloads the page. */
export function LangSwitch({ className = "" }: { className?: string }) {
  return (
    <div className={`seg lang-switch ${className}`} role="group" aria-label="Til / Язык">
      {LANGS.map((l) => (
        <button key={l.code} type="button" lang={l.code} title={l.label} aria-pressed={lang === l.code} className={lang === l.code ? "on" : ""} onClick={() => setLang(l.code)}>
          {l.short}
        </button>
      ))}
    </div>
  );
}
