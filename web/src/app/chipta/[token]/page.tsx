import type { Metadata } from "next";
import { TicketView } from "@/components/tickets/TicketView";
import { getT } from "@/lib/i18n/server";
import "../../tickets.css";

export async function generateMetadata(): Promise<Metadata> {
  const tx = await getT();
  return { title: tx("Chipta"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function TicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <div className="tk-root tk-page tk-ticket-page"><div className="container"><TicketView token={token} /></div></div>;
}
