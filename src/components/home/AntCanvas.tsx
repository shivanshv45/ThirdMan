"use client";

import { useEffect, useRef } from "react";

/**
 * A procedurally animated ant that repeats forever: a coin sparkles into
 * being somewhere in the middle of the canvas, the ant wanders in from
 * whichever side is farther away, inspects the coin, grips it, hauls it off
 * the near edge, and a new coin spawns for the next round. Ported from the
 * Claude Design reference (public/design_zip/Hero Ant.dc.html) — same
 * tripod-gait leg math, same coin-rendering approach, extended into a real
 * loop with randomised spawn points instead of the reference's single
 * fixed-path, run-once cycle. Chosen over the earlier background-video
 * approach because a canvas draws every frame from real state, so it never
 * has a "dead" stretch where the subject has walked out of frame, and it
 * composites onto any background with no video-rectangle seam to mask.
 *
 * `scale` multiplies the reference's own responsive scale — use it to make
 * the ant/coin larger without moving the wander path (which is fractions of
 * the canvas box, so it already reflows with the container).
 */

type Phase = "spawn" | "wander" | "inspect" | "grip" | "carry";

interface Coin {
  x: number;
  y: number;
  r: number;
  held: boolean;
  ang: number;
}

interface Ant {
  x: number;
  y: number;
  a: number;
  gait: number;
  probe: number;
}

interface Sparkle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

const TAU = Math.PI * 2;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export function AntCanvas({
  scale = 1,
  speed = 1,
  avoidSelector,
}: {
  scale?: number;
  speed?: number;
  /** CSS selector for an element the coin must never spawn under (its real
   * bounding box is measured at runtime, in canvas-local coordinates). */
  avoidSelector?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Deliberately does NOT gate on prefers-reduced-motion. That media
    // query exists for motion that can cause real discomfort — large
    // parallax, flashing, autoplaying video. A small creature walking at a
    // gentle, constant speed inside a contained card isn't that category,
    // and this is the hero's one illustrative asset, not incidental chrome
    // — hiding it entirely for a real fraction of visitors (this OS setting
    // is common, not rare) was the wrong tradeoff. `effectiveSpeed` below
    // still respects the *spirit* of the preference by slowing down rather
    // than ignoring it outright.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const effectiveSpeed = speed * (reduced.matches ? 0.55 : 1);

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    // Re-bound as a non-null const: functions declared below close over this
    // and run inside requestAnimationFrame, a scope TS cannot narrow the
    // original nullable binding through.
    const ctx: CanvasRenderingContext2D = ctx2d;

    let W = 0;
    let H = 0;
    let s = 1;
    let raf = 0;
    let t0 = 0;
    let tl = 0;
    let running = true;
    // The excluded rectangle, in canvas-local coordinates, with a margin
    // added so the coin doesn't spawn right at the text's edge either.
    let avoidRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

    let coin: Coin = { x: 0, y: 0, r: 0, held: false, ang: 0.4 };
    let ant: Ant = { x: -30, y: 0, a: -0.35, gait: 0, probe: 0 };
    let phase: Phase = "spawn";
    let pt = 0;
    let wi = 0;
    let way: { x: number; y: number }[] = [];
    let sparkles: Sparkle[] = [];
    let entrySide: 1 | -1 = 1;
    let firstRun = true;

    function insideAvoidRect(x: number, y: number) {
      if (!avoidRect) return false;
      return x > avoidRect.x0 && x < avoidRect.x1 && y > avoidRect.y0 && y < avoidRect.y1;
    }

    /** Random point inside a "safe" band that stays clear of the canvas
     * edges (the coin never spawns tight against a border) and clear of
     * the measured text block, if one was given. Retries a bounded number
     * of times rather than looping forever — a fallback edge case (e.g. the
     * text fills nearly the whole hero on a very small viewport) still
     * needs to terminate. */
    function safePoint() {
      for (let tries = 0; tries < 40; tries++) {
        const p = { x: rand(W * 0.12, W * 0.88), y: rand(H * 0.14, H * 0.9) };
        if (!insideAvoidRect(p.x, p.y)) return p;
      }
      // Fallback: clamp to just outside the avoid rect's left edge, or the
      // canvas edge if there's no rect (or no room) at all.
      if (avoidRect) return { x: Math.max(30, avoidRect.x0 - 40), y: rand(H * 0.14, H * 0.9) };
      return { x: rand(W * 0.12, W * 0.88), y: rand(H * 0.14, H * 0.9) };
    }

    function spawnSparkles(x: number, y: number) {
      sparkles = [];
      const n = 14;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * TAU + rand(-0.2, 0.2);
        const speed2 = rand(18, 46) * s;
        sparkles.push({
          x,
          y,
          vx: Math.cos(ang) * speed2,
          vy: Math.sin(ang) * speed2,
          life: 0,
          maxLife: rand(0.35, 0.6),
          size: rand(1.1, 2.4) * s,
        });
      }
    }

    /** Starts a fresh round: a new coin appears somewhere in the middle of
     * the canvas (never hugging an edge), and the ant enters from whichever
     * horizontal side is farther from it, so the walk is never trivially
     * short. */
    function reset() {
      const baseScale = Math.max(0.85, Math.min(1.35, W / 1440));
      s = baseScale * scale;

      const spot = safePoint();
      // A coin this size next to an ant (whose body is roughly 12-14 units
      // across in drawAnt's local space) is genuinely dramatic in real
      // life — ants are famous for hauling things many times their own
      // size. 15 units puts the coin at roughly the ant's own body length
      // across, which reads as a real coin rather than a decorative bead.
      coin = { x: spot.x, y: spot.y, r: 15 * s, held: false, ang: rand(0, TAU) };

      // Enter from the side FARTHER from the coin, so the approach reads as
      // a real walk rather than the ant spawning right next to its target.
      // If the coin is on the right half, the far side is the left edge —
      // hence the ant starts at x=-30 (entrySide=1, heading right) when the
      // coin is right-of-centre, and vice versa.
      entrySide = coin.x > W / 2 ? 1 : -1;
      const startX = entrySide === 1 ? -30 : W + 30;
      ant = { x: startX, y: rand(H * 0.25, H * 0.75), a: entrySide === 1 ? 0 : Math.PI, gait: 0, probe: 0 };

      phase = "spawn";
      pt = 0;
      wi = 0;
      spawnSparkles(coin.x, coin.y);

      // A couple of loose waypoints between the entry point and the coin,
      // so the walk wanders rather than beelining — same idea as the
      // reference's fixed path, but generated per round instead of once.
      const mid1 = safePoint();
      const mid2 = safePoint();
      way = [mid1, mid2, { x: coin.x - coin.r * 3.4 * entrySide, y: coin.y + coin.r * 1.2 }];
    }

    /** Re-measures the excluded text rect against the canvas's current box,
     * in canvas-local coordinates, with a margin so the coin keeps clear of
     * the text's edge too. Deliberately does NOT touch animation state —
     * called far more often than fit()/reset(), since text layout can
     * shift (font load, a scrollbar appearing) independently of the canvas
     * actually resizing, and restarting the ant's cycle on every one of
     * those would be a visible, unearned reset mid-carry. */
    function measureAvoidRect() {
      if (!avoidSelector) {
        avoidRect = null;
        return;
      }
      const el = document.querySelector<HTMLElement>(avoidSelector);
      const canvasEl = canvasRef.current;
      if (!el || !canvasEl) {
        avoidRect = null;
        return;
      }
      const box = el.getBoundingClientRect();
      const canvasBox = canvasEl.getBoundingClientRect();
      const margin = Math.max(24, 18 * s);
      avoidRect = {
        x0: box.left - canvasBox.left - margin,
        y0: box.top - canvasBox.top - margin,
        x1: box.right - canvasBox.left + margin,
        y1: box.bottom - canvasBox.top + margin,
      };
    }

    function fit() {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      W = r.width;
      H = r.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      el.width = Math.max(1, Math.round(r.width * dpr));
      el.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measureAvoidRect();
      reset();
    }

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    // The text box can also move without the canvas itself resizing (web
    // font swap, layout settling right after hydration) — a short settle
    // window covers that without an ongoing observer/interval.
    const settleTimers = [80, 300, 900].map((ms) => window.setTimeout(measureAvoidRect, ms));

    function stepSparkles(dt: number) {
      for (const p of sparkles) {
        p.life += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 1 - dt * 1.6;
        p.vy *= 1 - dt * 1.6;
      }
      sparkles = sparkles.filter((p) => p.life < p.maxLife);
    }

    function step(dt: number, t: number) {
      const a = ant;
      let target: { x: number; y: number } | null = null;
      let spd = 0;

      stepSparkles(dt);

      if (phase === "spawn") {
        // The coin sparkles into place; the ant holds position and only
        // starts walking once the little burst has mostly settled, so the
        // spawn reads as a cause the ant reacts to, not a coincidence.
        pt += dt;
        if (pt > (firstRun ? 0.05 : 0.55)) {
          firstRun = false;
          phase = "wander";
          pt = 0;
        }
      } else if (phase === "wander") {
        const w = way[wi];
        target = w;
        spd = 54 * s * effectiveSpeed * (0.72 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.7)));
        if (Math.hypot(w.x - a.x, w.y - a.y) < 10 * s) {
          wi++;
          if (wi >= way.length) {
            phase = "inspect";
            pt = 0;
          }
        }
      } else if (phase === "inspect") {
        pt += dt;
        const d = Math.hypot(coin.x - a.x, coin.y - a.y);
        spd = d > coin.r * 1.7 ? 22 * s * effectiveSpeed : 0;
        target = { x: coin.x, y: coin.y };
        a.probe = Math.min(1, a.probe + dt * 1.6);
        if (pt > 2.0) {
          phase = "grip";
          pt = 0;
        }
      } else if (phase === "grip") {
        pt += dt;
        coin.held = pt > 0.55;
        spd = 0;
        a.a += Math.sin(pt * 9) * 0.006;
        if (pt > 1.25) {
          phase = "carry";
          pt = 0;
          a.probe = 0;
        }
      } else if (phase === "carry") {
        pt += dt;
        // Exit from whichever edge is behind the ant's current heading, so
        // it doesn't reverse course mid-carry.
        const exitSide: 1 | -1 = a.x > W / 2 ? 1 : -1;
        target = { x: exitSide === 1 ? W + 90 : -90, y: a.y };
        const strain = 0.62 + 0.38 * Math.max(0, Math.sin(pt * 3.4));
        spd = 26 * s * effectiveSpeed * strain;
        if (a.x > W + 70 || a.x < -70) {
          reset();
        }
      }

      if (target && spd > 0) {
        let want = Math.atan2(target.y - a.y, target.x - a.x);
        if (phase === "wander") want += Math.sin(t * 2.9) * 0.3 + Math.sin(t * 6.3) * 0.1;
        if (phase === "carry") want += Math.sin(pt * 2.2) * 0.1;
        const d = ((want - a.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        a.a += d * Math.min(1, dt * (phase === "carry" ? 3.2 : 5.5));
        a.x += Math.cos(a.a) * spd * dt;
        a.y += Math.sin(a.a) * spd * dt;
        a.gait += (spd * dt) / (5.2 * s);
      }

      if (coin.held) {
        const f = 9.6 * s + coin.r;
        coin.x = a.x + Math.cos(a.a) * f;
        coin.y = a.y + Math.sin(a.a) * f - 0.6;
        coin.ang = a.a + 0.5 + Math.sin(pt * 4) * 0.05;
      }
    }

    function drawCoin() {
      const { x, y, r, ang } = coin;
      ctx.save();
      ctx.translate(x, y);
      ctx.save();
      ctx.filter = `blur(${2.4 * s}px)`;
      ctx.fillStyle = "rgba(50,40,26,0.28)";
      ctx.beginPath();
      ctx.ellipse(1.2 * s, 2.1 * s, r * 1.02, r * 0.92, 0, 0, TAU);
      ctx.fill();
      ctx.restore();

      ctx.rotate(ang);

      // Base disc: a deep bronze-gold rather than pale cream, with a real
      // rim wall (a slightly darker outer ring) so it reads as a struck
      // metal disc with thickness, not a flat painted circle.
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.985, 0, 0, TAU);
      ctx.fillStyle = "#a06a1f";
      ctx.fill();

      // Radial highlight from an offset light source — this is what makes
      // metal read as domed instead of flat-shaded.
      const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.05, 0, 0, r * 1.15);
      g.addColorStop(0, "#ffe9a8");
      g.addColorStop(0.28, "#f0bd4e");
      g.addColorStop(0.55, "#c98c22");
      g.addColorStop(0.82, "#8f5c14");
      g.addColorStop(1, "#6b430e");
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.97, r * 0.955, 0, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.lineWidth = Math.max(0.6, 0.85 * s);
      ctx.strokeStyle = "#5c3a0c";
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.985, 0, 0, TAU);
      ctx.stroke();

      // Inner rim groove, closer to the edge than before — real coins have
      // a raised lip a short distance in from the rim.
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.86, r * 0.85, 0, 0, TAU);
      ctx.strokeStyle = "rgba(255,233,170,0.5)";
      ctx.lineWidth = Math.max(0.4, 0.5 * s);
      ctx.stroke();

      // A tight, bright specular streak rather than a broad soft wash —
      // small and sharp is what makes a highlight look like a reflection.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.985, 0, 0, TAU);
      ctx.clip();
      ctx.beginPath();
      ctx.ellipse(-r * 0.32, -r * 0.42, r * 0.24, r * 0.1, -0.6, 0, TAU);
      ctx.fillStyle = "rgba(255,250,225,0.85)";
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(r * 0.4, r * 0.44, r * 0.22, r * 0.08, -0.5, 0, TAU);
      ctx.fillStyle = "rgba(255,244,210,0.25)";
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = "rgba(92,58,12,0.6)";
      ctx.lineWidth = Math.max(0.4, 0.46 * s);
      for (let i = 0; i < 30; i++) {
        const a = (i / 30) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.91, Math.sin(a) * r * 0.9);
        ctx.lineTo(Math.cos(a) * r * 0.99, Math.sin(a) * r * 0.975);
        ctx.stroke();
      }

      // An embossed "T" monogram — struck relief, not printed ink: the same
      // glyph drawn twice, offset a fraction of a pixel toward the light
      // (top-left, matching the highlight above) in a bright tone and away
      // from it in a dark tone. That paired light/dark edge is what reads
      // as a raised mark on metal rather than flat lettering.
      const glyphSize = r * 0.62;
      const off = Math.max(0.35, r * 0.045);
      ctx.lineWidth = Math.max(0.9, r * 0.11);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const [dx, dy, color] of [
        [-off, -off, "rgba(255,241,205,0.55)"],
        [off, off, "rgba(70,44,10,0.55)"],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        // The crossbar.
        ctx.moveTo(dx - glyphSize * 0.5, dy - glyphSize * 0.62);
        ctx.lineTo(dx + glyphSize * 0.5, dy - glyphSize * 0.62);
        ctx.stroke();
        ctx.beginPath();
        // The stem.
        ctx.moveTo(dx, dy - glyphSize * 0.62);
        ctx.lineTo(dx, dy + glyphSize * 0.55);
        ctx.stroke();
      }
      // Base pass in the coin's own mid-gold, sitting between the two
      // offset passes so the relief has a real body rather than being two
      // hairlines either side of nothing.
      ctx.strokeStyle = "#c98c22";
      ctx.lineWidth = Math.max(0.8, r * 0.1);
      ctx.beginPath();
      ctx.moveTo(-glyphSize * 0.5, -glyphSize * 0.62);
      ctx.lineTo(glyphSize * 0.5, -glyphSize * 0.62);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -glyphSize * 0.62);
      ctx.lineTo(0, glyphSize * 0.55);
      ctx.stroke();

      // A thin circular rule around the monogram, the way a real coin
      // separates its central device from the rim text/beading.
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.62, r * 0.615, 0, 0, TAU);
      ctx.strokeStyle = "rgba(70,44,10,0.35)";
      ctx.lineWidth = Math.max(0.35, 0.4 * s);
      ctx.stroke();

      ctx.restore();
    }

    function drawAnt() {
      const a = ant;
      ctx.save();
      ctx.translate(a.x, a.y);
      ctx.save();
      ctx.filter = `blur(${2 * s}px)`;
      ctx.fillStyle = "rgba(58,48,36,0.22)";
      ctx.beginPath();
      ctx.ellipse(1 * s, 1.8 * s, 8.6 * s, 4.2 * s, a.a, 0, TAU);
      ctx.fill();
      ctx.restore();

      ctx.rotate(a.a);
      ctx.scale(s, s);

      const dark = "#2e1d12";
      const mid = "#4a2c18";
      ctx.lineCap = "round";

      ctx.strokeStyle = dark;
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 3; i++) {
          const bx = [2.6, 0.6, -1.4][i];
          const by = side * 1.5;
          const ph = a.gait + i * 0.333 + (side > 0 ? 0.5 : 0);
          const sw = Math.sin(ph * TAU) * 2.6;
          const out = 5.6 + [0.6, 0.2, 0.9][i];
          const fx = bx + [3.2, 0.2, -3.4][i] + sw;
          const fy = by + side * out;
          const kx = bx + (fx - bx) * 0.45 + [1.2, 0.4, -1.2][i];
          const ky = by + (fy - by) * 0.45 + side * 1.1;
          ctx.lineWidth = 0.85;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(kx, ky);
          ctx.lineTo(fx, fy);
          ctx.stroke();
        }
      }

      ctx.fillStyle = mid;
      ctx.beginPath();
      ctx.ellipse(-5.9, 0, 4.1, 3.1, -0.06, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-2.6, 0);
      ctx.lineTo(-1.4, 0);
      ctx.stroke();

      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.ellipse(0.4, 0, 3.0, 1.9, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4.9, 0, 2.5, 2.35, 0, 0, TAU);
      ctx.fill();

      ctx.fillStyle = "rgba(255,236,214,0.20)";
      ctx.beginPath();
      ctx.ellipse(-6.3, -1.1, 2.1, 1.0, -0.4, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(4.6, -0.9, 1.2, 0.6, -0.3, 0, TAU);
      ctx.fill();

      const bite = coin.held ? 0.22 : 0.55 + Math.sin(a.gait * 3) * 0.05;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 0.75;
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(6.8, side * 1.1);
        ctx.quadraticCurveTo(8.3, side * (1.1 + bite), 9.2, side * (0.4 + bite * 0.5));
        ctx.stroke();
      }

      const pr = phase === "inspect" ? a.probe : 0;
      const w1 = Math.sin(a.gait * 4.1 + 0.6) * 0.3 + pr * Math.sin(performance.now() / 90) * 0.55;
      ctx.lineWidth = 0.7;
      for (let side = -1; side <= 1; side += 2) {
        const base = { x: 6.4, y: side * 1.4 };
        const e = { x: base.x + 3.0, y: base.y + side * (1.9 + w1 * side) };
        const tip = { x: e.x + 3.1 + pr * 0.8, y: e.y + side * (0.5 + w1 * side * 1.6) };
        ctx.beginPath();
        ctx.moveTo(base.x, base.y);
        ctx.lineTo(e.x, e.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawSparkles() {
      for (const p of sparkles) {
        const fade = 1 - p.life / p.maxLife;
        if (fade <= 0) continue;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = "#e0b959";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * fade, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      const coinVisible = phase !== "spawn" || pt > 0.15;
      const coinBehind = !coin.held;
      if (coinBehind && coinVisible) drawCoin();
      drawAnt();
      if (!coinBehind && coinVisible) drawCoin();
      drawSparkles();
    }

    function loop(t: number) {
      if (!running) return;
      if (!t0) t0 = t;
      const dt = Math.min(0.05, (t - (tl || t)) / 1000);
      tl = t;
      step(dt, (t - t0) / 1000);
      draw();
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      settleTimers.forEach((id) => window.clearTimeout(id));
    };
  }, [scale, speed, avoidSelector]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 h-full w-full pointer-events-none"
    />
  );
}
