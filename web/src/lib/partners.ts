import type { Partner, PartnerKind } from "./types";

import { lazyT, useT } from "@/lib/i18n";
/** Display order of the groups: the main sponsor first, media partners last. */
export const PARTNER_KINDS: { kind: PartnerKind; one: string; group: string; tab: string; slug: string }[] = lazyT([
  { kind: "main", one: "Bosh homiy", group: "Bosh homiy", tab: "Bosh homiy", slug: "bosh" },
  { kind: "official", one: "Rasmiy hamkor", group: "Rasmiy hamkorlar", tab: "Rasmiy hamkorlar", slug: "rasmiy" },
  { kind: "media", one: "Media hamkor", group: "Media hamkorlar", tab: "Media hamkorlar", slug: "media" },
], ["one", "group", "tab"] as const);

export const partnerKindLabel = (k: string) => {
  const tx = useT();
  return (PARTNER_KINDS.find((x) => x.kind === k)?.one || tx("Hamkor"));
};

/** Partners split by kind, in display order; empty groups are left out. */
export function partnerGroups(items: Partner[]) {
  return PARTNER_KINDS.map((k) => ({ ...k, list: items.filter((p) => p.kind === k.kind) })).filter((g) => g.list.length > 0);
}

/** «realme.com/uz» from «https://www.realme.com/uz/». */
export function partnerHost(url: string) {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

export const fmtVideoLength = (s?: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

/** Where «Hamkor bo‘lish» and «+ Sizning brendingiz» lead: the contact form. */
export const PARTNER_CONTACT = "/biz-haqimizda#aloqa";
