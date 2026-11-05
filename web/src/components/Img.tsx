import Image from "next/image";

type Props = { src: string; alt: string; sizes: string; priority?: boolean; className?: string; width?: number; height?: number; fill?: boolean };

/**
 * Uploaded images (/uploads/...) go through next/image: resized per device,
 * served as AVIF/WebP and cached. Anything else falls back to a plain <img>.
 */
export function Img({ src, alt, sizes, priority, className, width, height, fill = true }: Props) {
  if (src.startsWith("/uploads/")) {
    return fill ? (
      <Image src={src} alt={alt} fill sizes={sizes} priority={priority} className={className} style={{ objectFit: "cover" }} />
    ) : (
      <Image src={src} alt={alt} width={width || 1200} height={height || 630} sizes={sizes} priority={priority} className={className} style={{ width: "100%", height: "auto" }} />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async" width={width} height={height}
    style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" } : { width: "100%", height: "auto" }} />;
}
