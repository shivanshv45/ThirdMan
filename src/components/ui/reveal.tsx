"use client";

import { useEffect } from "react";

/**
 * Single page-wide IntersectionObserver that flips [data-reveal] and
 * [data-rise] elements to their "in" state once, as they scroll into
 * view. Adapted from ../../../payloadservice/src/components/Reveal/Reveal.tsx.
 * Under reduced motion, everything is set "in" immediately rather than
 * left invisible because the observer never fired.
 */
export function Reveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal], [data-rise]"));

    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      nodes.forEach((node) => {
        if (node.hasAttribute("data-reveal")) node.dataset.reveal = "in";
        if (node.hasAttribute("data-rise")) node.dataset.rise = "in";
      });
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const node = entry.target as HTMLElement;
          if (node.hasAttribute("data-reveal")) node.dataset.reveal = "in";
          if (node.hasAttribute("data-rise")) node.dataset.rise = "in";
          observer.unobserve(node);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 }
    );

    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return null;
}
