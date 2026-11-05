import { revalidateTag } from "next/cache";
import { API_TAG } from "@/lib/api";

// Called by the Go API after every admin change (see backend/internal/api/revalidate.go).
export async function POST(req: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false }, { status: 401 });
  }
  revalidateTag(API_TAG);
  return Response.json({ ok: true, revalidated: API_TAG, at: Date.now() });
}

export const dynamic = "force-dynamic";
