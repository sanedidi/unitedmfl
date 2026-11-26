import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { apiOrNull } from "@/lib/api";
import { idFromParam, matchPath, pageMeta } from "@/lib/seo";
import type { MatchDetail } from "@/lib/types";
import { ChevronRight } from "@/components/Icons";
import { CheckoutPage } from "@/components/tickets/CheckoutPage";
import "../../../tickets.css";

type P = Promise<{ id: string }>;
const load = cache(async (param: string) => {
  const id = idFromParam(param);
  return id ? apiOrNull<MatchDetail>(`/matches/${id}`, { revalidate: 30 }) : null;
});

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const d = await load((await params).id);
  if (!d) return { title: "Match topilmadi", robots: { index: false } };
  const m = d.match;
  const title = `Chipta: ${m.home?.name || "Aniqlanmagan"} — ${m.away?.name || "Aniqlanmagan"}`;
  return pageMeta({ title, description: `${title}. Oddiy va VIP zonalar, onlayn to‘lov, elektron chipta QR-kod bilan.`, path: `${matchPath(m)}/chipta`, noindex: true });
}

export default async function TicketCheckoutPage({ params }: { params: P }) {
  const d = await load((await params).id);
  if (!d) notFound();
  const m = d.match;
  return (
    <div className="tk-root">
      <div className="tk-crumbs"><div className="container">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/matchlar">Matchlar</Link><ChevronRight size={12} />
          {m.stage && <><Link href={`/matchlar?bosqich=${m.stage.id}`}>{m.stage.name}</Link><ChevronRight size={12} /></>}
          <Link href={matchPath(m)}>{m.home?.name || "Aniqlanmagan"} — {m.away?.name || "Aniqlanmagan"}</Link><ChevronRight size={12} />
          <b>Chipta</b>
        </nav>
      </div></div>
      <CheckoutPage m={m} />
    </div>
  );
}
