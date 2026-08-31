"use client";

import { useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

export function BrutalistStatement() {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLHeadingElement>(null);

  useGSAP(() => {
    if (!containerRef.current || !textRef.current) return;

    // A brutalist pop-in animation on scroll
    gsap.fromTo(
      textRef.current,
      {
        scale: 0.8,
        opacity: 0,
        rotation: -5,
      },
      {
        scale: 1,
        opacity: 1,
        rotation: 0,
        duration: 1,
        ease: "elastic.out(1, 0.5)",
        scrollTrigger: {
          trigger: containerRef.current,
          start: "top 75%",
          end: "top 25%",
          scrub: 1,
        },
      }
    );
  }, { scope: containerRef });

  return (
    <section
      ref={containerRef}
      className="relative w-full min-h-[80vh] flex flex-col items-center justify-center overflow-hidden"
      // Using a bright, bold pink background matching the reference exactly
      style={{ backgroundColor: "#ff82aa" }}
    >
      <div className="absolute top-12 text-black font-mono text-[12px] tracking-[0.2em] font-bold uppercase">
        The Core Rule
      </div>

      <div className="relative z-10 w-full max-w-[1200px] px-6 flex flex-col items-center text-center mt-8">
        <h2
          ref={textRef}
          className="font-black text-[clamp(4rem,15vw,12rem)] leading-[0.8] tracking-tighter uppercase text-white transform-gpu"
          style={{
            // Creating the thick neo-brutalism 3D shadow effect
            textShadow: `
              3px 3px 0 #000,
              -1px -1px 0 #000,
              1px -1px 0 #000,
              -1px 1px 0 #000,
              1px 1px 0 #000,
              6px 6px 0 #000,
              9px 9px 0 #000,
              12px 12px 0 #000,
              15px 15px 0 #000,
              18px 18px 0 #000
            `,
            fontFamily: "var(--font-display), sans-serif",
            WebkitTextStroke: "2px black"
          }}
        >
          THIRDMAN
        </h2>

        <p className="mt-16 text-black font-bold text-[clamp(1rem,2vw,1.5rem)] max-w-3xl leading-snug tracking-tight">
          AN AI BUYER AGENT FOR COMMERCE THAT SELLS{" "}
          <span className="bg-[#ccff00] px-2 py-1 border-2 border-black rounded-[4px] inline-block -rotate-2">
            BOUNDARIES
          </span>
          , NOT PROMISES.
          <br />
          <br />
          <span className="text-black/80 font-mono text-sm tracking-widest uppercase">
            AI DECIDES JUDGMENT. CODE DECIDES LIMITS.
          </span>
        </p>
      </div>

      {/* Decorative brutalist shapes floating around */}
      <div
        className="absolute -left-10 top-20 w-48 h-48 bg-[#fff066] border-[6px] border-black"
        style={{ transform: "rotate(-15deg)" }}
      />
      <div
        className="absolute -right-20 bottom-10 w-64 h-32 rounded-full bg-accent border-[6px] border-black"
        style={{ transform: "rotate(25deg)" }}
      />
    </section>
  );
}
