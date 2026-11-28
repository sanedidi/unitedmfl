import { useState } from "react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { PageHead, SITE_URL } from "@/components/Layout";
import { Badge, Empty, ErrorBox, Field, Loading, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

import { tx } from "@/lib/i18n";
type Post = { id: string; caption: string; media_type: string; is_reel: boolean; image_url: string; permalink: string; posted_at: string; is_hidden: boolean };
type State = { connected: boolean; api: string; username: string; token_expires_at: string | null; last_sync_at: string | null; last_error: string; posts: Post[] };

const kind = (p: Post) => (p.is_reel ? "Reels" : p.media_type === "VIDEO" ? tx("Video") : p.media_type === "CAROUSEL_ALBUM" ? tx("Albom") : tx("Rasm"));

export function InstagramPage() {
  const { data, error, loading, reload, setData } = useLoad(() => api.get<State>("/admin/instagram"), []);
  const [token, setToken] = useState("");
  const [igId, setIgId] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  async function connect() {
    setBusy(true);
    try {
      setData(await api.put<State>("/admin/instagram", { access_token: token.trim(), ig_user_id: igId.trim() }));
      setToken("");
      setIgId("");
      toast(tx("Instagram ulandi"));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  async function sync() {
    setBusy(true);
    try {
      setData(await api.post<State>("/admin/instagram/sync"));
      toast(tx("Yangilandi"));
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!(await confirm({ title: tx("Instagramni uzish"), text: tx("Saytdagi Instagram postlari o‘chiriladi. Qayta ulash uchun yangi token kerak bo‘ladi."), ok: tx("Uzish"), danger: true }))) return;
    await api.del("/admin/instagram").then(() => { toast(tx("Uzildi")); reload(); }, (e) => toast(e.message, "error"));
  }
  async function toggle(p: Post) {
    try {
      await api.patch(`/admin/instagram/posts/${p.id}`, { is_hidden: !p.is_hidden });
      setData(data && { ...data, posts: data.posts.map((x) => (x.id === p.id ? { ...x, is_hidden: !x.is_hidden } : x)) });
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
    }
  }

  const tokenForm = (
    <div className="stack">
      <Field label={tx("Access token")} hint={tx("Meta for Developers → ilova → Instagram API → «Generate access tokens». IGAA… va EAA… tokenlar qabul qilinadi. Token faqat serverda saqlanadi; IGAA… tokeni 60 kunda avtomatik yangilanadi.")}>
        <input className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tx("IGAA… yoki EAA…")} autoComplete="off" spellCheck={false} />
      </Field>
      {token.trim().startsWith("EAA") && (
        <Field label={tx("Instagram akkaunt ID (ixtiyoriy)")} hint={tx("Bo‘sh qoldirsangiz, avtomatik topiladi. Meta → Instagram API → 2-qadamda akkaunt nomi ostidagi raqam.")}>
          <input className="input" value={igId} onChange={(e) => setIgId(e.target.value.replace(/\D/g, ""))} placeholder="17841…" inputMode="numeric" />
        </Field>
      )}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={connect}>{busy ? tx("Tekshirilmoqda…") : data?.connected ? tx("Tokenni almashtirish") : tx("Ulash")}</button>
      </div>
    </div>
  );

  return (
    <>
      <PageHead
        title="Instagram"
        sub={<>{tx("Saytdagi")}{" "}<a href={`${SITE_URL}/media`} target="_blank" rel="noopener noreferrer">{tx("Media")}</a>{" "}{tx("sahifasida oxirgi 12 ta post ko‘rsatiladi. Har 30 daqiqada yangilanadi.")}</>}
        actions={data?.connected ? <>
          <button className="btn btn-ghost" disabled={busy} onClick={sync}><I.refresh size={16} />{" "}{tx("Hozir yangilash")}</button>
          <button className="btn btn-ghost" onClick={disconnect}><I.x size={16} />{" "}{tx("Uzish")}</button>
        </> : undefined}
      />
      {error ? <div className="card card-pad"><ErrorBox error={error} retry={reload} /></div> : loading && !data ? <Loading /> : data && (
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>{tx("Akkaunt")}</h2>
              {data.connected ? <Badge tone="ok">{tx("Ulangan")}</Badge> : <Badge>{tx("Ulanmagan")}</Badge>}
            </div>
            <div className="card-pad stack">
              {data.connected && (
                <div className="form-grid">
                  <div><div className="label">{tx("Akkaunt")}</div><a href={`https://www.instagram.com/${data.username}/`} target="_blank" rel="noopener noreferrer">@{data.username}</a></div>
                  <div><div className="label">{tx("Oxirgi yangilanish")}</div>{fmtDateTime(data.last_sync_at)}</div>
                  <div><div className="label">{tx("Token amal qiladi")}</div>{data.token_expires_at ? <>{fmtDate(data.token_expires_at)}{" "}{tx("gacha (avtomatik uzaytiriladi)")}</> : tx("Muddatsiz")}</div>
                  <div><div className="label">{tx("Postlar")}</div>{data.posts.length}{" "}{tx("ta, saytda")}{" "}{data.posts.filter((p) => !p.is_hidden).slice(0, 12).length}{" "}{tx("ta")}</div>
                </div>
              )}
              {data.last_error && <div className="alert danger"><I.alert size={16} /><div><b>{tx("Instagram xatosi:")}</b> {data.last_error}<br />{tx("Token muddati tugagan yoki bekor qilingan bo‘lsa, yangi token kiriting.")}</div></div>}
              {!data.connected && <div className="alert info"><I.alert size={16} /><div>{tx("Instagram akkaunti Professional (Business yoki Creator) bo‘lishi kerak.")}</div></div>}
              {data.connected ? <details><summary className="label" style={{ cursor: "pointer" }}>{tx("Tokenni almashtirish")}</summary><div style={{ marginTop: 12 }}>{tokenForm}</div></details> : tokenForm}
            </div>
          </div>

          {data.connected && (
            <div className="card">
              <div className="card-head"><h2>{tx("Postlar")}</h2><span className="muted small">{tx("Yashirilgan postlar saytda ko‘rinmaydi")}</span></div>
              {!data.posts.length ? <Empty title={tx("Postlar hali yo‘q")} text={tx("«Hozir yangilash» tugmasini bosing.")} /> : (
                <div className="table-wrap"><table className="table">
                  <thead><tr><th>{tx("Post")}</th><th className="hide-mobile">{tx("Turi")}</th><th className="hide-mobile">{tx("Sana")}</th><th>{tx("Saytda")}</th></tr></thead>
                  <tbody>
                    {data.posts.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <div className="row">
                            <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="img-preview" style={{ width: 56, height: 56, flexShrink: 0, backgroundImage: `url("${p.image_url}")`, opacity: p.is_hidden ? 0.4 : 1 }} aria-label={tx("Instagram’da ochish")} />
                            <div className="muted small" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{p.caption || "—"}</div>
                          </div>
                        </td>
                        <td className="hide-mobile">{kind(p)}</td>
                        <td className="hide-mobile nowrap">{fmtDate(p.posted_at)}</td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => toggle(p)}>
                            {p.is_hidden ? <><I.eye size={16} />{" "}{tx("Ko‘rsatish")}</> : <><I.x size={16} />{" "}{tx("Yashirish")}</>}
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
