"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

/**
 * One place that registers ScrollTrigger and owns the context lifecycle, so
 * every section below the hero animates through the same setup instead of
 * each file re-registering the plugin and hand-rolling its own cleanup.
 *
 * gsap.context() scopes every selector inside the callback to the returned
 * ref, which matters here because several sections use the same data-
 * attribute names — without scoping, one section's timeline would happily
 * grab another's elements.
 *
 * Reduced motion is handled by matchMedia rather than by skipping the
 * effect: elements start at opacity 0 in CSS, so a bailout that never runs
 * would leave the page blank. The reduced branch sets the end state
 * immediately instead.
 */

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

export function useGsapContext(
  setup: (ctx: {
    gsap: typeof gsap;
    root: HTMLElement;
    reduced: boolean;
  }) => void | (() => void),
  deps: unknown[] = [],
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // gsap.context() only reverts things IT created (tweens, ScrollTriggers).
    // A section that also attaches its own listener returns a teardown, which
    // is captured here and run alongside revert() — otherwise that listener
    // would outlive the component.
    let teardown: void | (() => void);
    const ctx = gsap.context(() => {
      teardown = setup({ gsap, root, reduced });
    }, root);

    return () => {
      if (typeof teardown === "function") teardown();
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

export { gsap, ScrollTrigger };
