import { api } from "./api";

export type KitStatus = "" | "queued" | "running" | "review" | "approved" | "rejected" | "error" | "skipped" | "multi" | "cancelled";

export type KitAnalysis = {
  people?: number;
  face_visible?: boolean;
  graphic?: boolean;
  wearing_jersey?: boolean;
  framing?: string;
  notes?: string;
  skipped?: boolean;
  studio?: boolean;
  head_shoulders?: boolean;
  front?: boolean;
};

export type KitPlayer = {
  id: number;
  kind: "player" | "staff";
  role?: string;
  full_name: string;
  number: number | null;
  team_id: number | null;
  photo_url: string;
  kit_photo_url: string;
  kit_approved_url: string;
  kit_status: KitStatus;
  kit_error: string;
  kit_hint: string;
  kit_analysis: KitAnalysis | null;
  kit_model: string;
  kit_updated_at: string | null;
  team_has_kit: boolean;
};

export type TeamKit = {
  team: { id: number; name: string; kit_url: string; kit_description: string };
  players: KitPlayer[];
  staff: KitPlayer[];
  counts: Partial<Record<KitStatus | "on_site", number>>;
  ai: { on: boolean; model: string; quality: string; auto_on_kit: boolean; auto_on_player: boolean };
};

export const kitApi = {
  team: (id: number) => api.get<TeamKit>(`/admin/teams/${id}/kit`),
  describe: (id: number) => api.post<{ kit_description: string }>(`/admin/teams/${id}/kit/describe`),
  saveDescription: (id: number, text: string) => api.patch(`/admin/teams/${id}`, { kit_description: text }),
  run: (id: number) => api.post<{ players: number }>(`/admin/teams/${id}/kit/run`),
  stop: (id: number) => api.post<{ players: number }>(`/admin/teams/${id}/kit/stop`),
  approveAll: (id: number) => api.post<{ players: number }>(`/admin/teams/${id}/kit/approve`),
  player: (id: number) => api.get<KitPlayer>(`/admin/players/${id}/kit`),
  act: (id: number, action: "approve" | "reject" | "revert" | "regenerate", hint?: string, kind: KitPlayer["kind"] = "player") =>
    api.post<KitPlayer>(`/admin/${kind === "staff" ? "team-staff" : "players"}/${id}/kit/${action}`, hint ? { hint } : undefined),
};

export const STAFF_ROLES: Record<string, string> = {
  head_coach: "Bosh murabbiy", assistant: "Yordamchi murabbiy", gk_coach: "Darvozabonlar murabbiyi",
  fitness: "Fitnes murabbiyi", doctor: "Shifokor", manager: "Menejer", other: "Shtab a’zosi",
};

export const busyStatus = (s: KitStatus) => s === "queued" || s === "running";

/** Plain-language lines for the analysis box. */
export function analysisLines(a: KitAnalysis | null | undefined): string[] {
  if (!a) return [];
  if (a.skipped) return ["Rasm tahlili o‘chirilgan — rasm oddiy portret deb qabul qilindi"];
  const out: string[] = [];
  if (a.graphic) out.push(a.studio ? "Afisha: matn, logotiplar va grafik fon bor → olib tashlandi, studiya foni" : "Afisha/grafika aniqlandi");
  if (a.front) out.push("Standart portret: kameraga to‘g‘ri qaraydi, ko‘krakkacha kadr, kulrang studiya foni");
  else if (a.graphic) { /* already said */ }
  else if (a.studio) out.push("Fon studiya foniga almashtirildi");
  else out.push("Oddiy rasm — asl fon saqlandi");
  if (a.people !== undefined) out.push(`${a.people} ta odam${a.face_visible ? ", yuz to‘liq ko‘rinadi" : ", yuz ko‘rinmaydi"}`);
  if (a.wearing_jersey) out.push("Allaqachon forma kiygan → yangi forma bilan almashtirildi");
  if (a.head_shoulders && !a.front) out.push("Kadr: bosh va yelka, 3:4 ga kesildi");
  if (a.notes) out.push(a.notes);
  return out;
}
