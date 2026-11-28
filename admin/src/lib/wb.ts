import { ApiError } from "./api";

import { tx } from "@/lib/i18n";
/* Wildberries store: shared types and labels (Merch, product page, Tizim → Wildberries). */

export type WBLog = { at: string; level: "ok" | "warn" | "error"; product_id: number | null; text: string };
export type WBState = {
  connected: boolean; token_broken: boolean; token_masked: string; expires_at: string | null; scopes: string[];
  seller: { name: string; sid: string; trademark: string; country: string };
  currency: string; link_domain: string; auto_push: boolean; pull_stocks: boolean; auto_out_of_stock: boolean;
  problem: "" | "token_invalid" | "wb_down"; last_error: string; last_sync_at: string | null; last_pull_at: string | null;
  site_url_missing: boolean;
  counts: Record<"products" | "on_wb" | "ready" | "queued" | "pending" | "incomplete" | "error" | "site_only" | "cards", number>;
  log: WBLog[];
};

export type WBProduct = {
  id: number; slug: string; name: string; category: string; price_uzs: number; sale_price_uzs: number | null; images: string[];
  status: string; visible: boolean; featured: boolean;
  wb_enabled: boolean; wb_state: "" | "incomplete" | "queued" | "pending" | "ready" | "error"; wb_error: string; wb_attempts: number;
  wb_nm_id: number | null; wb_vendor_code: string; wb_title: string; wb_price: number | null; wb_discount: number;
  wb_cur_price: number | null; wb_cur_discount: number | null; wb_cur_final: number | null; wb_stock: number | null;
  wb_sent_at: string | null; wb_pending_since: string | null; wb_next_try_at: string; wb_pulled_at: string | null; wb_media_hash: string;
};

export type WBVariant = { id: number; product_id: number; size: string; sku: string; stock: number | null; available: boolean; wb_size: string; barcode: string; wb_chrt_id: number | null; wb_stock: number | null };
export type WBSubject = { subjectID: number; parentID: number; subjectName: string; parentName: string };
export type WBCharc = { id: number; name: string; required: boolean; unit: string; max_count: number; number: boolean; popular: boolean; dict: string };
export type WBChar = { id: number; name: string; value: unknown };
export type WBImportItem = { nm_id: number; vendor_code: string; title: string; subject_name: string; photo: string; sizes: number };

export const errText = (e: unknown) => (e instanceof ApiError ? (Object.values(e.fields)[0] as string) || e.message : e instanceof Error ? e.message : tx("Xato"));

export type WBStatus = { key: string; dot: "ready" | "queued" | "error" | "no_logo" | "waiting"; label: string; sub: string };

/** The WB column of a product: label, dot colour and the line under it. */
export function wbStatus(p: WBProduct, fmt: (iso?: string | null) => string): WBStatus {
  if (!p.wb_enabled) return { key: "site", dot: "no_logo", label: tx("Faqat saytda"), sub: tx("WB’da sotish o‘chirilgan") };
  switch (p.wb_state) {
    case "incomplete": return { key: "error", dot: "error", label: tx("To‘ldirilmagan"), sub: p.wb_error.replace(/^To‘ldirilmagan: /, "") };
    case "queued": return { key: "pending", dot: "queued", label: tx("Navbatda"), sub: p.wb_attempts > 0 ? tx("{0}-urinish: {1}", p.wb_attempts, p.wb_error) : tx("WB’ga yuborilmoqda") };
    case "pending": return { key: "pending", dot: "queued", label: tx("Moderatsiyada"), sub: tx("Yuborildi: {0}", fmt(p.wb_pending_since || p.wb_sent_at)) };
    case "error": return { key: "error", dot: "error", label: tx("Xato"), sub: p.wb_error };
    case "ready":
      if (p.status === "out_of_stock" || p.wb_stock === 0) return { key: "ready", dot: "queued", label: tx("Tugagan"), sub: tx("WB omborida qoldiq 0") };
      return { key: "ready", dot: "ready", label: tx("Sotuvda"), sub: p.wb_nm_id ? `nm ${p.wb_nm_id}` : "" };
    default: return { key: "pending", dot: "waiting", label: tx("Yuborilmagan"), sub: tx("Saqlang yoki «WB’ga yuborish»ni bosing") };
  }
}

export const wbLink = (nm: number | null | undefined, domain = "wildberries.uz") => (nm ? `https://${domain}/catalog/${nm}/detail.aspx` : "");
export const SELLER_URL = "https://seller.wildberries.ru";
