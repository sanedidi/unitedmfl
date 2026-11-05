import { useState, type ReactNode } from "react";

/** Textarea with a preview for the Markdown subset the public site renders. */
export function Markdown({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="hint small muted">## Sarlavha · **qalin** · *kursiv* · - ro‘yxat · &gt; iqtibos · [matn](https://…)</span>
        <div className="seg">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>Matn</button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>Ko‘rish</button>
        </div>
      </div>
      {preview ? <div className="md-preview">{render(value)}</div> : <textarea className="textarea" style={{ minHeight: 280 }} value={value} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

export function render(text: string): ReactNode {
  const blocks = (text || "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return <span className="muted">Matn yo‘q</span>;
  return blocks.map((b, i) => {
    if (b.startsWith("### ")) return <h3 key={i}>{inline(b.slice(4))}</h3>;
    if (b.startsWith("## ") || b.startsWith("# ")) return <h2 key={i}>{inline(b.replace(/^#+ /, ""))}</h2>;
    const lines = b.split("\n");
    if (lines.every((l) => /^[-*] /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.slice(2))}</li>)}</ul>;
    if (lines.every((l) => /^\d+[.)] /.test(l))) return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+[.)] /, ""))}</li>)}</ol>;
    if (lines.every((l) => l.startsWith(">"))) return <blockquote key={i}>{inline(lines.map((l) => l.replace(/^>\s?/, "")).join(" "))}</blockquote>;
    return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l)}</span>)}</p>;
  });
}
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
  let last = 0, k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1]) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2]) out.push(<em key={k++}>{m[2]}</em>);
    else out.push(<a key={k++} href={m[4]} target="_blank" rel="noreferrer" style={{ color: "var(--text-accent)", textDecoration: "underline" }}>{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
