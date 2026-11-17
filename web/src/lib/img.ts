import { getImageProps } from "next/image";

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/+$/, "");

/** Site-relative path of one of our uploads ("/uploads/…"), or "" for anything else. */
export function uploadPath(src: string | null | undefined): string {
  if (!src) return "";
  if (src.startsWith("/uploads/")) return src;
  if (SITE && src.startsWith(SITE + "/uploads/")) return src.slice(SITE.length);
  return "";
}

type ImgSrc = { src: string; srcSet?: string; sizes?: string };

/**
 * Props for a plain <img> that shows an uploaded image `width` CSS px wide:
 * the browser gets a resized WebP from the image optimizer (1x and 2x),
 * never the full-size original. Other sources (YouTube, SVG logos) pass through.
 */
export function sized(src: string, width: number, quality?: number): ImgSrc {
  const path = uploadPath(src);
  if (!path || /\.svg(\?|$)/i.test(path)) return { src };
  const { props } = getImageProps({ src: path, alt: "", width, height: width, quality });
  return { src: props.src, srcSet: props.srcSet };
}

/** Like sized(), for images whose width follows the layout (`sizes` as in next/image). */
export function responsive(src: string, sizes: string, quality?: number): ImgSrc {
  const path = uploadPath(src);
  if (!path || /\.svg(\?|$)/i.test(path)) return { src };
  const { props } = getImageProps({ src: path, alt: "", width: 1920, height: 1080, sizes, quality });
  return { src: props.src, srcSet: props.srcSet, sizes: props.sizes };
}
