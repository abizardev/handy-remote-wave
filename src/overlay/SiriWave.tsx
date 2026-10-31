import React, { useEffect, useRef } from "react";

// Siri-style multi-curve waveform for the Handy recording overlay. Draws 4
// sine layers whose amplitude follows the live mic level (same `mic-level`
// 16-bucket event payload the built-in pill waveform uses). Self-contained:
// one canvas, one rAF loop, no dependencies.
const CURVES = 4;
const SAMPLES = 96;
const BASE_CENTER = [-0.35, 0.4, 0.05, -0.7];
const FREQ_MUL = [1, 1.3, 0.75, 1.55];
const FLOW_MUL = [1, 1.2, 0.85, 1.4];
const WOBBLE_RATE = [1.3, 1.7, 2.1, 1.1];
// Colors follow the outer theme: light theme gets saturated cyan→violet,
// dark theme the brighter classic Siri palette.
const LIGHT_PALETTE: [string, string] = ["#22d3ee", "#e879f9"];
const DARK_PALETTE: [string, string] = ["#69d2e7", "#b97af1"];

const mixHex = (a: string, b: string, t: number): string => {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (x: number, s: number) =>
    Math.round(((x >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  const r = ch(pa, 16);
  const g = ((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t;
  const bl = (pa & 255) * (1 - t) + (pb & 255) * t;
  return `rgb(${r},${Math.round(g)},${Math.round(bl)})`;
};

const desat = (c: string, t: number): string => {
  if (t <= 0) return c;
  const p = parseInt(c.startsWith("#") ? c.slice(1) : c.replace("#"), 16);
  const r = (p >> 16) & 255;
  const g = (p >> 8) & 255;
  const b = p & 255;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return `rgb(${Math.round(r + (y - r) * t)},${Math.round(g + (y - g) * t)},${Math.round(b + (y - b) * t)})`;
};

const rgbaFrom = (c: string, a: number): string => {
  if (c.startsWith("rgb("))
    return c.replace("rgb(", "rgba(").replace(")", `,${a})`);
  const p = parseInt(c.slice(1), 16);
  return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${a})`;
};

interface SiriWaveProps {
  levels: number[];
  ready: boolean;
  className?: string;
}

const SiriWave: React.FC<SiriWaveProps> = ({ levels, ready, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const levelsRef = useRef(levels);
  const readyRef = useRef(ready);
  levelsRef.current = levels;
  readyRef.current = ready;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssH = 36;
    const cssW = 176;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cy = cssH / 2;
    const hu = 168 / 44; // vertical unit vs. the pill row
    const ampMax = 14 * hu;

    const dark = document.documentElement.classList.contains("dark");
    const [c0, c1] = dark ? DARK_PALETTE : LIGHT_PALETTE;
    const palette: string[] = [
      c0,
      c1,
      mixHex(c0, c1, 0.5),
      mixHex(c0, c1, 0.25),
    ];
    const lineColors = palette.map((c) => desat(c, dark ? 0 : 0.25));

    const xs = new Float32Array(SAMPLES);
    const xn = new Float32Array(SAMPLES);
    const edge = new Float32Array(SAMPLES);
    const ys = new Float32Array(SAMPLES);
    for (let j = 0; j < SAMPLES; j += 1) {
      const u = j / (SAMPLES - 1);
      xs[j] = u * cssW;
      xn[j] = (u * 2 - 1) * 2;
      const e = 1 - (u * 2 - 1) ** 2;
      edge[j] = e * e;
    }

    const amps = [0.02, 0.02, 0.02, 0.02];
    const centers = BASE_CENTER.map((c) => c * 0.35);
    const phases = [0.3, 2.1, 4.2, 5.4];
    let freqS = 1.6;
    let levelS = 0;
    let prev = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - prev) / 1000, 0.1);
      prev = now;

      // Live mic level: loudest bucket of the 16 FFT bands sent by the backend.
      const burst = levelsRef.current || [];
      let m = 0;
      for (let i = 0; i < burst.length; i += 1) if (burst[i] > m) m = burst[i];
      const target = readyRef.current ? Math.pow(m, 0.7) : 0.04;
      levelS += (target - levelS) * (1 - Math.exp(-14 * dt));

      ctx.clearRect(0, 0, cssW, cssH);
      ctx.globalCompositeOperation = "lighter";

      for (let k = CURVES - 1; k >= 0; k -= 1) {
        const base = (0.035 + 0.06 * levelS) * (dark ? 1 : 0.92);
        const tTarget = base;
        amps[k] += (tTarget - amps[k]) * (1 - Math.exp(-12 * dt));
        const wob =
          1 -
          0.3 * (0.5 + 0.5 * Math.sin((now / 1000) * WOBBLE_RATE[k] + k * 1.4));
        const amp = amps[k] * wob * ampMax;
        const fk = (freqS + 1.8 * levelS) * FREQ_MUL[k];
        phases[k] += dt * (1.6 + levelS * 2.2) * FLOW_MUL[k];
        const liveC =
          BASE_CENTER[k] * 0.35 * (1 - levelS * 0.55) +
          k * 0.04 * Math.sin(now / 1000 + k);
        centers[k] += (liveC - centers[k]) * (1 - Math.exp(-10 * dt));
        const c = centers[k];

        for (let j = 0; j < SAMPLES; j += 1) {
          const u = (xn[j] - c) / 1;
          const u4 = u * u * u * u;
          const env = 2 / (2 + u4);
          ys[j] = amp * env * env * edge[j] * Math.sin(fk * xn[j] - phases[k]);
        }

        ctx.beginPath();
        ctx.moveTo(xs[0], cy - ys[0]);
        for (let j = 1; j < SAMPLES; j += 1) ctx.lineTo(xs[j], cy - ys[j]);
        for (let j = SAMPLES - 1; j >= 0; j -= 1) ctx.lineTo(xs[j], cy + ys[j]);
        ctx.closePath();

        ctx.globalAlpha = 0.24;
        ctx.strokeStyle = rgbaFrom(palette[k], 1);
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.globalAlpha = dark ? 0.95 : 0.8;
        ctx.strokeStyle = lineColors[k];
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      // Reduced motion: settle in (~1s) then hold a static frame.
      if (!reduced || now - startAt < 1000) requestAnimationFrame(frame);
    };
    const startAt = performance.now();
    requestAnimationFrame(frame);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: 176, height: 36 }}
    />
  );
};

export default SiriWave;
