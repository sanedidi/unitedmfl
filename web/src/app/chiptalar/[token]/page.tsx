import type { Metadata } from "next";
import { Suspense } from "react";
import { OrderView } from "@/components/tickets/OrderView";
import { Steps } from "@/components/tickets/Checkout";
import "../../tickets.css";

export const metadata: Metadata = { title: "Chiptalaringiz", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="tk-root">
      <div className="tk-top"><div className="container"><div className="tk-title"><h1 className="h1">Chiptalaringiz</h1><Steps step={3} /></div></div></div>
      <div className="tk-page"><div className="container"><Suspense><OrderView token={token} /></Suspense></div></div>
    </div>
  );
}
