import { ogImage, OG_SIZE, OG_TYPE } from "@/lib/og";

export const alt = "United MFL — Media Football League";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({ kicker: "Media Football League", title: "United MFL", subtitle: "Matchlar · Natijalar · Turnir jadvali · Jamoalar" });
}
