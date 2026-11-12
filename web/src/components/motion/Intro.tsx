"use client";
import { useEffect, useRef, useState } from "react";
import { Emblem } from "./Emblem";

const KEY = "mfl:intro";

/**
 * Inline, render-blocking boot script (placed at the top of <body>). It decides
 * before the first paint whether this visit shows the intro: once per browser
 * session, never for bots/headless tools. The intro itself is pure CSS from the
 * first frame, so it never waits for JavaScript.
 */
export const INTRO_BOOT = `(function(){try{var d=document.documentElement,n=navigator;if(n.webdriver||/bot|crawl|spider|slurp|lighthouse|headless|preview|facebookexternalhit|telegram/i.test(n.userAgent))return;if(sessionStorage.getItem("${KEY}"))return;sessionStorage.setItem("${KEY}","1");d.setAttribute("data-intro","on")}catch(e){}})();`;

const EMPH = "cubic-bezier(.76,0,.24,1)";
const OUT = "cubic-bezier(.16,1,.3,1)";
const DOCK_AT = 1600; // ms from the start of the intro
const DOCK_MS = 500;

/**
 * Intro «Kick-off»: the emblem assembles on a graphite curtain, «United MFL»
 * appears beside it, then the curtain lifts and the lockup flies into its place
 * in the header. CSS runs the timeline; this component only adds what CSS can't
 * know: the exact header position (docking), skip on interaction, and cleanup.
 */
export function Intro() {
  const root = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const html = document.documentElement;
    const el = root.current;
    if (html.dataset.intro !== "on" || !el) {
      setGone(true);
      return;
    }
    const q = <T extends Element>(s: string) => el.querySelector<T>(s);
    const curtain = q<HTMLElement>(".kick-curtain")!;
    const lockup = q<HTMLElement>(".kick-lockup")!;
    const badge = q<HTMLElement>(".kick-badge")!;
    const main = document.getElementById("main");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anims: Animation[] = [];
    const timers: number[] = [];
    let ended = false;

    const finish = () => {
      if (ended) return;
      ended = true;
      html.setAttribute("data-intro", "done");
      anims.forEach((a) => a.cancel());
      setGone(true);
    };

    // How far the CSS timeline already is (hydration can arrive late on slow networks).
    const cssAnim = curtain.getAnimations()[0];
    const elapsed = typeof cssAnim?.currentTime === "number" ? cssAnim.currentTime : 0;

    if (reduced) {
      timers.push(window.setTimeout(finish, Math.max(0, 600 - elapsed)));
      return () => timers.forEach(clearTimeout);
    }
    if (elapsed >= DOCK_AT + DOCK_MS) {
      finish();
      return;
    }

    // Centre the solo emblem precisely (CSS only has an estimate of the name's width).
    badge.style.setProperty("--dx", `${(lockup.offsetWidth - badge.offsetWidth) / 2}px`);

    const canDock = elapsed < DOCK_AT - 100;
    if (canDock) {
      el.classList.add("js-dock");
      // Page content waits 24px lower under the curtain and settles when it lifts.
      if (main) anims.push(main.animate([{ transform: "translateY(24px)" }, { transform: "none" }], { duration: DOCK_MS, delay: DOCK_AT - elapsed, easing: OUT, fill: "backwards" }));
      timers.push(window.setTimeout(dock, DOCK_AT - elapsed));
    } else {
      timers.push(window.setTimeout(finish, DOCK_AT + 300 - elapsed));
    }

    function dock() {
      const target = document.querySelector<HTMLElement>(".header .brand .logo-badge");
      const t = target?.getBoundingClientRect();
      if (!t || !t.width || t.bottom < 0) {
        el!.classList.remove("js-dock"); // header not on screen: let the CSS fade handle it
        timers.push(window.setTimeout(finish, 320));
        return;
      }
      const l = lockup.getBoundingClientRect();
      const b = badge.getBoundingClientRect();
      const ox = b.left - l.left + b.width / 2;
      const oy = b.top - l.top + b.height / 2;
      const s = t.width / b.width;
      const tx = t.left + t.width / 2 - (b.left + b.width / 2);
      const ty = t.top + t.height / 2 - (b.top + b.height / 2);
      lockup.style.transformOrigin = `${ox}px ${oy}px`;
      const fly = lockup.animate([{ transform: "none" }, { transform: `translate(${tx}px, ${ty}px) scale(${s})` }], { duration: DOCK_MS, easing: EMPH, fill: "forwards" });
      anims.push(fly);
      // The name turns from white to the header's ink colour just before landing.
      const ink = getComputedStyle(document.documentElement);
      const name = q<HTMLElement>(".kick-text b");
      const sub = q<HTMLElement>(".kick-text small");
      if (name) anims.push(name.animate([{ color: "#fff" }, { color: ink.getPropertyValue("--text").trim() || "#15181c" }], { duration: 60, delay: 400, fill: "forwards" }));
      if (sub) anims.push(sub.animate([{ color: "rgba(255,255,255,.6)" }, { color: ink.getPropertyValue("--text-muted").trim() || "#6e7581" }], { duration: 60, delay: 400, fill: "forwards" }));
      fly.finished.then(finish, () => {});
    }

    // Any interaction skips the intro: the curtain leaves in 300 ms.
    const skip = () => {
      if (ended || el.classList.contains("is-skipping")) return;
      el.classList.add("is-skipping");
      timers.forEach(clearTimeout);
      const from = getComputedStyle(curtain).transform;
      curtain.style.animation = "none";
      anims.push(curtain.animate([{ transform: from === "none" ? "none" : from }, { transform: "translateY(-100%)" }], { duration: 300, easing: EMPH, fill: "forwards" }));
      anims.push(lockup.animate([{ opacity: getComputedStyle(lockup).opacity }, { opacity: 0 }], { duration: 150, fill: "forwards" }));
      if (main) main.getAnimations().forEach((a) => a.cancel());
      timers.push(window.setTimeout(finish, 300));
    };
    const evs = ["pointerdown", "wheel", "touchmove", "keydown"] as const;
    evs.forEach((e) => window.addEventListener(e, skip, { passive: true }));

    return () => {
      evs.forEach((e) => window.removeEventListener(e, skip));
      timers.forEach(clearTimeout);
    };
  }, []);

  if (gone) return null;
  return (
    <div className="kick" ref={root} aria-hidden="true">
      <div className="kick-curtain" />
      <div className="kick-stage">
        <div className="kick-lockup">
          <span className="kick-text">
            <span className="kick-text-in">
              <b>United MFL</b>
              <small>Media Football League</small>
            </span>
          </span>
          <span className="kick-badge">
            <Emblem />
          </span>
        </div>
      </div>
    </div>
  );
}
