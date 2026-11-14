import { api } from "./api";

export type ProviderName = "openai" | "gemini";

export type ProviderView = {
  provider: ProviderName;
  connected: boolean;
  key_mask: string;
  org_id: string;
  base_url: string;
  status: "ok" | "error" | "unknown" | "off";
  checked_at: string | null;
  latency_ms: number;
  image_models: string[];
  text_models: string[];
  last_error: string;
};

export type AiFormat = { label: string; w: number; h: number; enabled: boolean };

export type AiSettings = {
  provider: ProviderName;
  fallback: boolean;
  image_model: Record<string, string>;
  text_model: Record<string, string>;
  quality: "low" | "medium" | "high";
  variants: number;
  file_format: "webp" | "jpeg" | "png";
  compression: number;
  formats: Record<string, AiFormat>;
  format_order: string[];
  style: string;
  forbidden: string;
  text_space: boolean;
  moderation: "auto" | "low";
  people: "ALLOW_ADULT" | "ALLOW_ALL" | "DONT_ALLOW";
  improve_instruction: string;
  improve_language: "user" | "en";
  default_assets: Record<string, boolean>;
  max_assets: number;
  kit: KitSettings;
};

export type KitSettings = {
  auto_on_kit: boolean;
  auto_on_player: boolean;
  describe: boolean;
  analyze: boolean;
  quality: "low" | "medium" | "high";
  size: "original" | "portrait";
  background: "auto" | "keep" | "studio";
  framing: "auto" | "keep" | "head_shoulders";
  prompt: string;
};

export type AiImage = { url: string; mime: string; width: number; height: number };
export type AiGeneration = {
  id: number;
  user_name: string;
  target: string;
  target_id: number | null;
  layout: string;
  prompt_original: string;
  prompt: string;
  formats: string[];
  assets: string[];
  status: "running" | "done" | "applied" | "saved" | "error" | "cancelled";
  error: string;
  provider: string;
  model: string;
  duration_ms: number;
  variants: { images: Record<string, AiImage> }[];
  applied_variant: number | null;
  warnings: string[];
  created_at: string;
};

export type BannerText = { title: string; badge: string; meta: boolean; cta: boolean };
export type Improved = { prompt: string; added: string[]; provider: string; model: string; ms: number };

export const PROVIDER_LABEL: Record<string, string> = { openai: "OpenAI", gemini: "Google Gemini" };
export const QUALITY_LABEL: Record<string, string> = { low: "Past", medium: "O‘rta", high: "Yuqori" };
export const STATUS_LABEL: Record<AiGeneration["status"], string> = {
  running: "Yaratilmoqda", done: "Tayyor", applied: "Bannerda", saved: "Saqlangan", error: "Xato", cancelled: "Bekor qilingan",
};

export const aiApi = {
  providers: () => api.get<{ providers: ProviderView[] }>("/admin/ai/providers").then((r) => r.providers),
  saveProvider: (p: ProviderName, body: { api_key: string; org_id?: string; base_url?: string }) => api.put<ProviderView>(`/admin/ai/providers/${p}`, body),
  testProvider: (p: ProviderName) => api.post<ProviderView>(`/admin/ai/providers/${p}/test`),
  deleteProvider: (p: ProviderName) => api.del(`/admin/ai/providers/${p}`),
  settings: () => api.get<AiSettings>("/admin/ai/settings"),
  saveSettings: (s: AiSettings) => api.put<AiSettings>("/admin/ai/settings", s),
  improve: (body: { prompt: string; layout: string; assets: string[]; banner?: BannerText }) => api.post<Improved>("/admin/ai/improve", body),
  start: (body: unknown) => api.post<AiGeneration>("/admin/ai/generations", body),
  get: (id: number) => api.get<AiGeneration>(`/admin/ai/generations/${id}`),
  cancel: (id: number) => api.post<AiGeneration>(`/admin/ai/generations/${id}/cancel`),
  apply: (id: number, variant: number, targetId?: number | null) => api.post<AiGeneration>(`/admin/ai/generations/${id}/apply`, { variant, target_id: targetId ?? null }),
  save: (id: number) => api.post<AiGeneration>(`/admin/ai/generations/${id}/save`),
};
