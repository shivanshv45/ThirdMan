"use client";

import type { ReactNode } from "react";
import { useGsapContext } from "./use-gsap";

/**
 * The 404's entrance, kept as a thin client wrapper so not-found.tsx itself
 * stays a server component and ships no JS for the copy it renders. One
 * stagger on mount — no scroll triggers here, since there is nothing to
 * scroll to on this page.
 */
export function NotFoundMotion({ children }: { children: ReactNode }) {
  const ref = useGsapContext(({ gsap, root, reduced }) => {
    const items = Array.from(root.firstElementChild?.children ?? []);
    if (!items.length) return;

    if (reduced) {
      gsap.set(items, { autoAlpha: 1, y: 0 });
      return;
    }

    gsap.set(items, { autoAlpha: 0, y: 22 });
    gsap.to(items, {
      autoAlpha: 1,
      y: 0,
      duration: 0.75,
      stagger: 0.075,
      ease: "power3.out",
      delay: 0.05,
    });
  }, []);

  return <div ref={ref}>{children}</div>;
}
