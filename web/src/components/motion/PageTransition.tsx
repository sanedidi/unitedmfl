"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { Emblem } from "./Emblem";

type Kind = "stinger" | "pass" | "fade";
type Run = { kind: Kind; href: string; covered: Promise<void>; coveredAt: number; pushed: boolean; done: boolean; waitTimer?: number; failTimer?: number };

const EMPH = "cubic-bezier(.76,0,.24,1)";
const OUT = "cubic-bezier(.16,1,.3,1)";
const BACK = "cubic-bezier(.34,1.56,.64,1)";
const ENTER = 340; // panel slides in
const HOLD = 120; // minimum full cover
const EXIT = 340; // panel slides out
const STINGER_COOLDOWN = 4000; // a second section change sooner than this uses the light transition
const GIVE_UP = 8000; // a page slower than this shows its own loading/error state

const section = (p: string) => p.split("/")[1] || "";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Page transitions for the public site.
 *  • «Stinger» — between top-level sections: a graphite panel with lime edges
 *    sweeps across with the emblem in the middle and stays until the new page
 *    is ready (so it doubles as the loading indicator).
 *  • «Pass» — inside a section and for back/forward: the header emblem pulses,
 *    a lime line runs under the header, content cross-fades.
 *  • Reduced motion — a 150 ms fade only.
 */
export function PageTransition() {
  const router = useRouter();
  const path = usePathname();
  const [pending, startTransition] = useTransition();
  const layer = useRef<HTMLDivElement>(null);
  const run = useRef<Run | null>(null);
  const lastStinger = useRef(-Infinity);
  const popped = useRef(false);
  const prevPath = useRef(path);

  // Intercept internal link clicks before next/link handles them.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.hasAttribute("download") || a.dataset.noTransition !== undefined) return;
      if (a.target && a.target !== "_self") return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || /^\/(api|uploads)\//.test(url.pathname) || /\.[a-z0-9]{2,5}$/i.test(url.pathname)) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page / hash link
      if (document.documentElement.dataset.intro === "on") return;

      e.preventDefault();
      const href = url.pathname + url.search + url.hash;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      let kind: Kind = section(url.pathname) !== section(location.pathname) ? "stinger" : "pass";
      if (kind === "stinger" && performance.now() - lastStinger.current < STINGER_COOLDOWN) kind = "pass";
      if (reduced) kind = "fade";
      start(kind, href);
    };
    const onPop = () => {
      popped.current = true;
    };
    window.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start(kind: Kind, href: string) {
    const el = layer.current;
    const main = document.getElementById("main");
    if (!el || !main) return router.push(href);
    const cur = run.current;
    if (cur && !cur.done) {
      // Another click while a transition is running: retarget it.
      cur.href = href;
      if (cur.pushed) startTransition(() => router.push(href));
      return;
    }
    main.getAnimations().forEach((a) => a.cancel());
    const r: Run = { kind, href, covered: Promise.resolve(), coveredAt: performance.now(), pushed: false, done: false };
    const go = () => {
      r.pushed = true;
      startTransition(() => router.push(r.href));
    };
    run.current = r;
    el.dataset.kind = kind;
    el.dataset.active = "true";

    if (kind === "stinger") {
      lastStinger.current = performance.now();
      const W = window.innerWidth;
      const mobile = W < 720;
      const d = mobile ? 90 : 180;
      el.style.setProperty("--d", `${d}px`);
      el.style.setProperty("--s", `${mobile ? 8 : 16}px`);
      const panel = el.querySelector<HTMLElement>(".pt-panel")!;
      const badge = el.querySelector<HTMLElement>(".pt-badge")!;
      const letters = el.querySelector<SVGElement>(".pt-badge .em-lettering")!;
      el.classList.remove("is-waiting");
      panel.getAnimations().forEach((a) => a.cancel());
      badge.getAnimations().forEach((a) => a.cancel());
      const enter = panel.animate([{ transform: `translateX(${W + d}px)` }, { transform: "none" }], { duration: ENTER, easing: EMPH, fill: "forwards" });
      main.animate([{ transform: "none" }, { transform: "translateX(-24px)" }], { duration: ENTER, easing: EMPH, fill: "forwards" });
      badge.animate([{ opacity: 0, transform: "scale(.6)" }, { opacity: 1, transform: "scale(1)" }], { duration: 230, delay: 190, easing: BACK, fill: "both" });
      letters.animate([{ transform: "rotate(90deg)" }, { transform: "none" }], { duration: 260, delay: 190, easing: OUT, fill: "both" });
      r.covered = enter.finished.then(() => {
        r.coveredAt = performance.now();
      }, () => {});
      // Navigate only once the screen is covered, so the swap is never visible.
      r.covered.then(() => {
        if (run.current !== r) return;
        r.waitTimer = window.setTimeout(() => el.classList.add("is-waiting"), HOLD);
        go();
      });
    } else if (kind === "pass") {
      passOut(el, main);
      go();
    } else {
      main.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, fill: "forwards" });
      go();
    }
    r.failTimer = window.setTimeout(() => finish(r), GIVE_UP);
  }

  function passOut(el: HTMLElement, main: HTMLElement) {
    const header = document.querySelector(".header");
    el.style.setProperty("--top", `${Math.max(0, header?.getBoundingClientRect().bottom ?? 0) - 2}px`);
    const line = el.querySelector<HTMLElement>(".pt-line")!;
    line.getAnimations().forEach((a) => a.cancel());
    line.animate([{ transform: "scaleX(0)", opacity: 1 }, { transform: "scaleX(.8)", opacity: 1 }], { duration: 300, easing: OUT, fill: "forwards" });
    document.querySelector(".header .brand .logo-badge")?.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
    main.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" });
  }

  async function finish(r: Run) {
    if (r.done) return;
    r.done = true;
    clearTimeout(r.waitTimer);
    clearTimeout(r.failTimer);
    const el = layer.current;
    const main = document.getElementById("main");
    if (!el || !main) return;

    if (r.kind === "stinger") {
      await r.covered;
      const left = HOLD - (performance.now() - r.coveredAt);
      if (left > 0) await wait(left);
      el.classList.remove("is-waiting");
      const W = window.innerWidth;
      const d = parseFloat(el.style.getPropertyValue("--d")) || 180;
      const panel = el.querySelector<HTMLElement>(".pt-panel")!;
      const badge = el.querySelector<HTMLElement>(".pt-badge")!;
      badge.animate([{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.85)" }], { duration: 120, easing: "ease-in", fill: "forwards" });
      main.getAnimations().forEach((a) => a.cancel());
      main.animate([{ transform: "translateX(24px)" }, { transform: "none" }], { duration: EXIT, easing: OUT });
      const exit = panel.animate([{ transform: "none" }, { transform: `translateX(${-(W + d)}px)` }], { duration: EXIT, easing: EMPH, fill: "forwards" });
      await exit.finished.catch(() => {});
      if (run.current !== r) return;
      focusHeading(main);
    } else if (r.kind === "pass") {
      passIn(el, main);
      await wait(180);
    } else {
      main.getAnimations().forEach((a) => a.cancel());
      main.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
      await wait(150);
    }
    if (run.current === r) {
      el.dataset.active = "false";
      run.current = null;
    }
  }

  function passIn(el: HTMLElement, main: HTMLElement) {
    const line = el.querySelector<HTMLElement>(".pt-line")!;
    line.getAnimations().forEach((a) => a.cancel());
    line.animate([{ transform: "scaleX(.8)", opacity: 1 }, { transform: "scaleX(1)", opacity: 1, offset: 0.4 }, { transform: "scaleX(1)", opacity: 0 }], { duration: 300, easing: "ease-out", fill: "forwards" });
    const from = Number(getComputedStyle(main).opacity) || 0;
    main.getAnimations().forEach((a) => a.cancel());
    main.animate([{ opacity: Math.min(from, 1), transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: OUT });
  }

  // The new route is committed when the transition stops pending (covers query-only changes too).
  useEffect(() => {
    const r = run.current;
    if (r && !r.done && r.pushed && !pending) finish(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  // Back/forward: Next swaps the page itself; play the light transition on arrival.
  useEffect(() => {
    if (prevPath.current === path) return;
    prevPath.current = path;
    const r = run.current;
    if (r && !r.done) {
      if (r.pushed) finish(r);
      return;
    }
    if (!popped.current) return;
    popped.current = false;
    const el = layer.current;
    const main = document.getElementById("main");
    if (!el || !main || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.kind = "pass";
    el.dataset.active = "true";
    const header = document.querySelector(".header");
    el.style.setProperty("--top", `${Math.max(0, header?.getBoundingClientRect().bottom ?? 0) - 2}px`);
    document.querySelector(".header .brand .logo-badge")?.animate([{ transform: "scale(1)" }, { transform: "scale(1.15)" }, { transform: "scale(1)" }], { duration: 300, easing: "ease-out" });
    passIn(el, main);
    window.setTimeout(() => {
      if (!run.current) el.dataset.active = "false";
    }, 320);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="pt" ref={layer} data-active="false" aria-hidden="true">
      <div className="pt-panel">
        <i className="pt-edge pt-edge-lead" />
        <i className="pt-edge pt-edge-trail" />
      </div>
      <div className="pt-centre">
        <span className="pt-badge">
          <Emblem />
        </span>
      </div>
      <div className="pt-line" />
    </div>
  );
}

function focusHeading(main: HTMLElement) {
  const h = main.querySelector<HTMLElement>("h1") || main;
  if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
  h.focus({ preventScroll: true });
}
