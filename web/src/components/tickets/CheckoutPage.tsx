"use client";
import { useState } from "react";
import { Checkout, Steps } from "./Checkout";
import { Crest } from "@/components/Crest";
import { Calendar, Clock, Pin } from "@/components/Icons";
import { fmtDate, fmtTime } from "@/lib/format";
import type { Match } from "@/lib/types";

import { useT } from "@/lib/i18n";
export function CheckoutPage({ m }: { m: Match }) {
  const tx = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const days = m.kickoff_at ? Math.ceil((new Date(m.kickoff_at).getTime() - Date.now()) / 86400000) : null;
  return (
    <>
      <div className="tk-top">
        <div className="container">
          <div className="tk-title"><h1 className="h1">{tx("Chipta sotib olish")}</h1><Steps step={step} /></div>
          <div className="tk-match">
            <span className="tk-teams"><Crest team={m.home} size={28} unknownLabel="?" /><b>{m.home?.name || tx("Aniqlanmagan")}</b><span className="muted">{tx("vs")}</span><b>{m.away?.name || tx("Aniqlanmagan")}</b><Crest team={m.away} size={28} unknownLabel="?" /></span>
            {m.kickoff_at && <span><Calendar size={16} /> {fmtDate(m.kickoff_at)}</span>}
            {m.kickoff_at && <span><Clock size={16} />{" "}{tx("{0} (Toshkent)", fmtTime(m.kickoff_at))}</span>}
            {m.venue && <span><Pin size={16} /> {m.venue}</span>}
            <span className="grow" />
            {m.stage && <span className="badge badge-stage">{m.stage.name}</span>}
            {days != null && days > 0 && <span className="badge badge-upcoming">{tx("Boshlanishiga {0} kun", days)}</span>}
          </div>
        </div>
      </div>
      <div className="tk-page"><div className="container"><Checkout matchId={m.id} onStep={setStep} /></div></div>
      <div id="tk-toast" className="tk-toast" role="alert" />
    </>
  );
}
