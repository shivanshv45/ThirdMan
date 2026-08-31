import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces, Archivo_Black } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  style: ["normal", "italic"],
});

const archivoBlack = Archivo_Black({
  variable: "--font-archivo-black",
  weight: "400",
  subsets: ["latin"],
});

// No merchant-facing env var names a production domain yet (see
// PROGRESS.md/DECISIONS.md — deliberately not guessed, a wrong hardcoded
// value would actively break social-share image URLs post-deploy).
// VERCEL_URL is set automatically by Vercel's own build environment, so
// this resolves correctly the moment this app is deployed there without
// any manual configuration; it only falls back to localhost in dev.
//
// Reads process.env directly rather than importing { env } from
// src/lib/env.ts: this runs at module load for every route (Next.js
// statically collects metadata during the build's page-data step, e.g.
// for /_not-found), and this value is cosmetic, not a secret — it
// doesn't need the full required-vars validation env.ts otherwise
// enforces, and shouldn't force a build to have every production
// credential present just to compute a URL for social-share tags.
// Mirrors getAppUrl()'s precedence (APP_URL, then VERCEL_URL, then dev),
// reading process.env rather than importing it for the reason above.
const siteUrl =
  process.env.APP_URL?.replace(/\/+$/, "") ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "ThirdMan — Agentic Commerce for AI Buyers",
    template: "%s — ThirdMan",
  },
  description: "Bounded, gated money actions for AI buyer agents — spend caps, an audit trail, and automatic revenue recovery, built on your own payment account.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} ${archivoBlack.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
