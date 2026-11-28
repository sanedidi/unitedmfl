import type { Metadata } from "next";
import { Suspense } from "react";
import { OrderView } from "@/components/tickets/OrderView";
import { Steps } from "@/components/tickets/Checkout";
import { getT } from "@/lib/i18n/server";
import "../../tickets.css";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("Chiptalaringiz"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const tx = await getT();
  const { token } = await params;
  return (
    <div className="tk-root">
      <div className="tk-top"><div className="container"><div className="tk-title"><h1 className="h1">{tx("Chiptalaringiz")}</h1><Steps step={3} /></div></div></div>
      <div className="tk-page"><div className="container"><Suspense><OrderView token={token} /></Suspense></div></div>
    </div>
  );
}
