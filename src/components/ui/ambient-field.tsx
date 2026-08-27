"use client";

import { useEffect, useRef } from "react";

interface Blob {
  x: number;
  y: number;
  r: number;
  color: string;
  driftX: number;
  driftY: number;
  phase: number;
}

/**
 * A slow, abstract canvas backdrop for the landing hero — the product's
 * own ambient-video equivalent (see plans/layer-9's fact 5), built
 * procedurally instead of shipping a video file: zero binary weight, no
 * licensing question, guaranteed-fast LCP, and it can render the actual
 * decision-triad palette rather than stock footage of something unrelated.
 * Every blob just drifts on an independent sine path — nothing here
 * represents real data, so it stays purely decorative background, never
 * dressed up as a chart or a live figure.
 */
export function AmbientField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      const parent = canvas!.parentElement;
      width = parent?.clientWidth ?? window.innerWidth;
      height = parent?.clientHeight ?? window.innerHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    const palette = ["#4fd1c5", "#3ecf8e", "#e8a13d", "#f2545b"];
    const blobs: Blob[] = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.18 + Math.random() * 0.14,
      color: palette[i % palette.length],
      driftX: 0.05 + Math.random() * 0.06,
      driftY: 0.04 + Math.random() * 0.05,
      phase: Math.random() * Math.PI * 2,
    }));

    let raf = 0;
    const start = performance.now();

    function frame(now: number) {
      const t = (now - start) / 1000;
      ctx!.clearRect(0, 0, width, height);

      for (const b of blobs) {
        const cx = (b.x + Math.sin(t * 0.05 + b.phase) * b.driftX) * width;
        const cy = (b.y + Math.cos(t * 0.04 + b.phase) * b.driftY) * height;
        const radius = b.r * Math.max(width, height);

        const gradient = ctx!.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `${b.color}26`);
        gradient.addColorStop(1, `${b.color}00`);
        ctx!.fillStyle = gradient;
        ctx!.beginPath();
        ctx!.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx!.fill();
      }

      if (!reduceMotion) raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    // Reduced motion: draw exactly one frame, then stop — a static
    // composition instead of no backdrop at all.
    if (reduceMotion) {
      frame(start);
      cancelAnimationFrame(raf);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden="true" />;
}
