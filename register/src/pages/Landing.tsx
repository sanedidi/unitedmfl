import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, rememberDraft, savedDraft, type PublicLink } from "@/lib/api";
import { Hero, Page, StateCard } from "@/components/Shell";
import { CheckLine, Loading, Spinner, useToast } from "@/components/ui";
import { I } from "@/components/Icons";

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
          {draft && <Link className="link-btn" to={`/a/${draft}`}>Boshlangan arizani ochish <I.arrow size={14} /></Link>}
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
      toast(e instanceof Error ? e.message : "Xato", "error");
      setBusy(false);
    }
  }
  const r = link.requirements;
  const reqs = [
    `${r.min_players} dan ${r.max_players} gacha kishi (o‘yinchilar, media shaxslar va murabbiylar)`,
    "Har bir o‘yinchi: ism, familiya, tug‘ilgan sana, raqam, futbolkadagi yozuv, forma o‘lchami",
    r.logo ? "Jamoa logotipi (PNG/JPG, kamida 512×512)" : "Jamoa logotipi — ixtiyoriy",
    r.medical ? "Har bir o‘yinchiga tibbiy ruxsatnoma" : "Tibbiy ruxsatnomalar — keyin ham yuklash mumkin",
    r.photo ? "Har bir o‘yinchining fotosi" : "",
    r.min_age ? `O‘yinchilar kamida ${r.min_age} yoshda` : "",
    r.phone ? "Vakil telefoni SMS-kod bilan tasdiqlanadi" : "",
  ].filter(Boolean);

  return (
    <Page>
      <Hero link={link} />
      <div className="wrap">
        <div className="cols wide" style={{ maxWidth: 1100, margin: "0 auto", gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
          <div className="card">
            <div className="card-head"><h3>Nima kerak bo‘ladi</h3></div>
            <div className="card-pad stack" style={{ gap: 12 }}>
              {reqs.map((t) => <CheckLine key={t} level="ok">{t}</CheckLine>)}
              <div className="note" style={{ marginTop: 8 }}>
                <I.download size={16} />
                <div>Tarkib hozir Excel’da bo‘lsa (TARKIB.xlsx), uni 3-qadamda yuklaysiz — qo‘lda kiritish shart emas. <a href={api.templateUrl}>Shablonni yuklab olish</a></div>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-pad stack">
              <h3 style={{ fontSize: 18 }}>Arizani to‘ldirish</h3>
              <p className="sec">Ariza avtomatik saqlanadi: sahifani yopsangiz ham, shu qurilmada to‘xtagan joyingizdan davom etasiz.</p>
              {draft ? (
                <>
                  <Link className="btn btn-primary btn-lg btn-block" to={`/a/${draft}`}>Arizani davom ettirish <I.arrow size={16} /></Link>
                  <button className="btn btn-ghost btn-block" onClick={start} disabled={busy}>{busy ? <Spinner /> : "Yangi ariza boshlash"}</button>
                </>
              ) : (
                <button className="btn btn-primary btn-lg btn-block" onClick={start} disabled={busy}>{busy ? <Spinner /> : <>Arizani boshlash <I.arrow size={16} /></>}</button>
              )}
              {link.rules_url && <a className="link-btn" href={link.rules_url} target="_blank" rel="noopener noreferrer"><I.doc size={16} /> Liga reglamenti</a>}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}
