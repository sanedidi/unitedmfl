import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "./Icons";
import { useT } from "@/lib/i18n";

export function SectionHead({ overline, title, href, linkLabel: linkLabelProp, children }: { overline?: string; title: string; href?: string; linkLabel?: string; children?: ReactNode }) {
  const tx = useT();
  const linkLabel = linkLabelProp ?? tx("Barchasi");
  return (
    <div className="section-head">
      <div>
        {overline && <div className="overline">{overline}</div>}
        <h2 className="h2">{title}</h2>
        {children}
      </div>
      {href && (
        <Link href={href} className="link-more">
          {linkLabel} <ArrowRight />
        </Link>
      )}
    </div>
  );
}

export function PageTitle({ overline, title, lead, children }: { overline?: string; title: string; lead?: string; children?: ReactNode }) {
  return (
    <header className="page-title">
      <div className="container">
        {overline && <div className="overline">{overline}</div>}
        <h1 className="h1">{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
    </header>
  );
}
