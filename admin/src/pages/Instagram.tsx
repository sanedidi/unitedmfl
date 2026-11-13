import { useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Field, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

type Post = { id: string; caption: string; media_type: string; is_reel: boolean; image_url: string; permalink: string; posted_at: string; is_hidden: boolean };
type State = { connected: boolean; username: string; token_expires_at: string | null; last_sync_at: string | null; last_error: string; posts: Post[] };

const kind = (p: Post) => (p.is_reel ? "Reels" : p.media_type === "VIDEO" ? "Video" : p.media_type === "CAROUSEL_ALBUM" ? "Albom" : "Rasm");

export function InstagramPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<State>("/admin/instagram"), []);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  async function connect() {
    setBusy(true);
    try {
      setData(await api.put<State>("/admin/instagram", { access_token: token.trim() }));
      setToken("");
      toast("Instagram ulandi");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setBusy(true);
    try {
      setData(await api.post<State>("/admin/instagram/sync"));
      toast("Yangilandi");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!(await confirm({ title: "Instagramni uzish", text: "Saytdagi Instagram postlari o‘chiriladi. Qayta ulash uchun yangi token kerak bo‘ladi.", ok: "Uzish", danger: true }))) return;
    await api.del("/admin/instagram").then(() => { toast("Uzildi"); reload(); }, (e) => toast(e.message, "error"));
  }
  async function toggle(p: Post) {
    try {
      await api.patch(`/admin/instagram/posts/${p.id}`, { is_hidden: !p.is_hidden });
      setData(data && { ...data, posts: data.posts.map((x) => (x.id === p.id ? { ...x, is_hidden: !x.is_hidden } : x)) });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Xato", "error");
    }
  }

  const tokenForm = (
    <div className="stack">
      <Field label="Access token" hint="Meta for Developers → ilova → Instagram → API setup with Instagram login → Generate access tokens. Token faqat serverda saqlanadi va 60 kunda avtomatik yangilanadi.">
        <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA…" autoComplete="off" spellCheck={false} />
      </Field>
      <div className="row">
        <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={connect}>{busy ? "Tekshirilmoqda…" : data?.connected ? "Tokenni almashtirish" : "Ulash"}</button>
      </div>
    </div>
  );

  return (
    <>
      <PageHead
        title="Instagram"
        sub={<>Saytdagi <a href={`${SITE_URL}/media`} target="_blank" rel="noopener noreferrer">Media</a> sahifasida oxirgi 12 ta post ko‘rsatiladi. Har 30 daqiqada yangilanadi.</>}
        actions={data?.connected ? <>
          <button className="btn btn-ghost" disabled={busy} onClick={sync}><I.refresh size={16} /> Hozir yangilash</button>
          <button className="btn btn-ghost" onClick={disconnect}><I.x size={16} /> Uzish</button>
        </> : undefined}
      />
      {error ? <div className="card card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : data && (
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Akkaunt</h2>
              {data.connected ? <Badge tone="ok">Ulangan</Badge> : <Badge>Ulanmagan</Badge>}
            </div>
            <div className="card-pad stack">
              {data.connected && (
                <div className="form-grid">
                  <div><div className="label">Akkaunt</div><a href={`https://www.instagram.com/${data.username}/`} target="_blank" rel="noopener noreferrer">@{data.username}</a></div>
                  <div><div className="label">Oxirgi yangilanish</div>{fmtDateTime(data.last_sync_at)}</div>
                  <div><div className="label">Token amal qiladi</div>{fmtDate(data.token_expires_at)} gacha (avtomatik uzaytiriladi)</div>
                  <div><div className="label">Postlar</div>{data.posts.length} ta, saytda {data.posts.filter((p) => !p.is_hidden).slice(0, 12).length} ta</div>
                </div>
              )}
              {data.last_error && <div className="alert danger"><I.alert size={16} /><div><b>Instagram xatosi:</b> {data.last_error}<br />Token muddati tugagan yoki bekor qilingan bo‘lsa, yangi token kiriting.</div></div>}
              {!data.connected && <div className="alert info"><I.alert size={16} /><div>Instagram akkaunti Professional (Business yoki Creator) bo‘lishi kerak.</div></div>}
              {data.connected ? <details><summary className="label" style={{ cursor: "pointer" }}>Tokenni almashtirish</summary><div style={{ marginTop: 12 }}>{tokenForm}</div></details> : tokenForm}
            </div>
          </div>

          {data.connected && (
            <div className="card">
              <div className="card-head"><h2>Postlar</h2><span className="muted small">Yashirilgan postlar saytda ko‘rinmaydi</span></div>
              {!data.posts.length ? <Empty title="Postlar hali yo‘q" text="«Hozir yangilash» tugmasini bosing." /> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>Post</th><th className="hide-mobile">Turi</th><th className="hide-mobile">Sana</th><th>Saytda</th></tr></thead>
                  <tbody>
                    {data.posts.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div className="row">
                            <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="img-preview" style={{ width: 56, height: 56, flexShrink: 0, backgroundImage: `url("${p.image_url}")`, opacity: p.is_hidden ? 0.4 : 1 }} aria-label="Instagram’da ochish" />
                            <div className="muted small" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{p.caption || "—"}</div>
                          </div>
                        </td>
                        <td className="hide-mobile">{kind(p)}</td>
                        <td className="hide-mobile nowrap">{fmtDate(p.posted_at)}</td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => toggle(p)}>
                            {p.is_hidden ? <><I.eye size={16} /> Ko‘rsatish</> : <><I.x size={16} /> Yashirish</>}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
