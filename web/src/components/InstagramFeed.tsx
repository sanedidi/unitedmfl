import type { InstagramFeed as Feed, InstagramPost } from "@/lib/types";
import { Instagram, Play } from "./Icons";
import { fmtDate } from "@/lib/format";

/** Carousel marker: two stacked squares. */
const Stack = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="7" y="7" width="13" height="13" rx="2" />
    <path d="M4 16V6a2 2 0 0 1 2-2h10" />
  </svg>
);

function caption(p: InstagramPost) {
  const t = p.caption.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 137).trimEnd() + "…" : t;
}

function label(p: InstagramPost) {
  if (p.is_reel) return "Reels";
  if (p.media_type === "VIDEO") return "Video";
  if (p.media_type === "CAROUSEL_ALBUM") return "Albom";
  return "Post";
}

export function InstagramFeed({ feed }: { feed: Feed }) {
  if (!feed.username || feed.posts.length === 0) return null;
  const profile = `https://www.instagram.com/${feed.username}/`;
  return (
    <section className="ig-feed" aria-labelledby="ig-title">
      <div className="ig-head">
        <div>
          <div className="overline">Instagram</div>
          <h2 className="h3" id="ig-title">@{feed.username}</h2>
        </div>
        <a className="btn btn-ghost btn-sm" href={profile} target="_blank" rel="noopener noreferrer">
          <Instagram /> Obuna bo‘lish
        </a>
      </div>
      <ul className="ig-grid">
        {feed.posts.map((p) => {
          const text = caption(p);
          const video = p.is_reel || p.media_type === "VIDEO";
          return (
            <li key={p.id}>
              <a className="ig-tile" href={p.permalink} target="_blank" rel="noopener noreferrer"
                 aria-label={`${label(p)}, ${fmtDate(p.posted_at)}${text ? `: ${text}` : ""} — Instagram’da ochish`}>
                <img src={p.image_url} alt="" loading="lazy" decoding="async" width={540} height={540} />
                {video && <span className="ig-mark"><Play size={14} /></span>}
                {!video && p.media_type === "CAROUSEL_ALBUM" && <span className="ig-mark"><Stack /></span>}
                <span className="ig-over">
                  {text && <span className="ig-cap">{text}</span>}
                  <span className="ig-date">{fmtDate(p.posted_at)}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      <div className="ig-more">
        <a className="link-more" href={profile} target="_blank" rel="noopener noreferrer">Instagram’da barchasi →</a>
      </div>
    </section>
  );
}
