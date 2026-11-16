import { api } from "@/lib/api";
import { DEFAULT_LAYOUT, type Layout } from "@/lib/layout";
import { pageMeta } from "@/lib/seo";
import { HomeLayout } from "@/components/home/HomeLayout";

export const metadata = pageMeta({
  title: "United MFL — media futbol ligasi: matchlar va natijalar",
  absoluteTitle: true,
  description: "United MFL — blogerlar, sportchilar va san’at yulduzlari jamoalari ligasi: matchlar taqvimi, jonli hisob, natijalar, turnir jadvali va yangiliklar.",
  path: "/",
});

/** The published layout from the admin's builder; the built-in default if the API is down. */
async function publishedLayout(): Promise<Layout> {
  try {
    const r = await api<{ version: number; config: Layout }>("/homepage", { revalidate: 30 });
    return r.config?.rows ? r.config : DEFAULT_LAYOUT;
  } catch (e) {
    console.error(e);
    return DEFAULT_LAYOUT;
  }
}

// Rendered per request (see the root layout): time-scheduled blocks switch on
// and off on their own, without publishing again.
export default async function Home() {
  return <HomeLayout layout={await publishedLayout()} now={Date.now()} />;
}
