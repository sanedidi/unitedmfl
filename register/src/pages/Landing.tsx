import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, rememberDraft, savedDraft, type PublicLink } from "@/lib/api";
import { Hero, Page, StateCard } from "@/components/Shell";
import { CheckLine, Loading, Spinner, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

import { tx } from "@/lib/i18n";
/** Root page: the link the admin put on the main page, or «closed». */
export function HomePage() {
  const [link, setLink] = useState<PublicLink | null | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    api.home().then((d) => setLink(d.link)).catch(() => setError(true));
  }, []);
  if (error) return <Page><StateCard state="none" /></Page>;
  if (link === undefined) return <Page><Loading /></Page>;
  if (!link) return <Page><StateCard state="none" /></Page>;
  return <LinkLanding link={link} />;
}

/** /{code}: a link sent by the league. */
export function LinkPage() {
  const { code = "" } = useParams();
  const [link, setLink] = useState<PublicLink | null | undefined>(undefined);
  useEffect(() => {
    setLink(undefined);
    api.link(code).then(setLink).catch((e) => setLink(e instanceof ApiError && e.status === 404 ? null : null));
  }, [code]);
  if (link === undefined) return <Page><Loading /></Page>;
  if (!link) return <Page><StateCard state="missing" /></Page>;
  return <LinkLanding link={link} />;
}

function LinkLanding({ link }: { link: PublicLink }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const draft = savedDraft(link.code);

  if (link.state !== "open") {
    return (
      <Page>
        <StateCard state={link.state} link={link}>
          {draft && <Link className="link-btn" to={`/a/${draft}`}>{tx("Boshlangan arizani ochish")}{" "}<I.arrow size={14} /></Link>}
        </StateCard>
      </Page>
    );
  }

  async function start() {
    setBusy(true);
    try {
      const a = await api.create(link.code);
      rememberDraft(link.code, a.token);
      navigate(`/a/${a.token}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : tx("Xato"), "error");
      setBusy(false);
    }
  }
  const r = link.requirements;
  const reqs = [
    tx("{0} dan {1} gacha kishi (o‘yinchilar, media shaxslar va murabbiylar)", r.min_players, r.max_players),
    tx("Har bir o‘yinchi: ism, familiya, tug‘ilgan sana, raqam, futbolkadagi yozuv, forma o‘lchami"),
    r.logo ? tx("Jamoa logotipi (PNG/JPG, kamida 512×512)") : tx("Jamoa logotipi — ixtiyoriy"),
    r.medical ? tx("Har bir o‘yinchiga tibbiy ruxsatnoma") : tx("Tibbiy ruxsatnomalar — keyin ham yuklash mumkin"),
    r.photo ? tx("Har bir o‘yinchining fotosi") : "",
    r.min_age ? tx("O‘yinchilar kamida {0} yoshda", r.min_age) : "",
    r.phone ? tx("Vakil telefoni SMS-kod bilan tasdiqlanadi") : "",
  ].filter(Boolean);

  return (
    <Page>
      <Hero link={link} />
      <div className="wrap">
        <div className="cols wide" style={{ maxWidth: 1100, margin: "0 auto", gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
          <div className="card">
            <div className="card-head"><h3>{tx("Nima kerak bo‘ladi")}</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              {reqs.map((t) => <CheckLine key={t} level="ok">{t}</CheckLine>)}
              <div className="note" style={{ marginTop: 8 }}>
                <I.download size={16} />
                <div>{tx("Tarkib hozir Excel’da bo‘lsa (TARKIB.xlsx), uni 3-qadamda yuklaysiz — qo‘lda kiritish shart emas.")}{" "}<a href={api.templateUrl}>{tx("Shablonni yuklab olish")}</a></div>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-pad stack">
              <h3 style={{ fontSize: 18 }}>{tx("Arizani to‘ldirish")}</h3>
              <p className="sec">{tx("Ariza avtomatik saqlanadi: sahifani yopsangiz ham, shu qurilmada to‘xtagan joyingizdan davom etasiz.")}</p>
              {draft ? (
                <>
                  <Link className="btn btn-primary btn-lg btn-block" to={`/a/${draft}`}>{tx("Arizani davom ettirish")}{" "}<I.arrow size={16} /></Link>
                  <button className="btn btn-ghost btn-block" onClick={start} disabled={busy}>{busy ? <Spinner /> : tx("Yangi ariza boshlash")}</button>
                </>
              ) : (
                <button className="btn btn-primary btn-lg btn-block" onClick={start} disabled={busy}>{busy ? <Spinner /> : <>{tx("Arizani boshlash")}{" "}<I.arrow size={16} /></>}</button>
              )}
              {link.rules_url && <a className="link-btn" href={link.rules_url} target="_blank" rel="noopener noreferrer"><I.doc size={16} />{" "}{tx("Liga reglamenti")}</a>}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
