import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { env } from "@/lib/env";
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

// No merchant-facing env var names a production domain yet (see
// PROGRESS.md/DECISIONS.md — deliberately not guessed, a wrong hardcoded
// value would actively break social-share image URLs post-deploy).
// VERCEL_URL is set automatically by Vercel's own build environment, so
// this resolves correctly the moment this app is deployed there without
// any manual configuration; it only falls back to localhost in dev.
const siteUrl = env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "ThirdMan — Agentic Commerce for Razorpay Merchants",
    template: "%s — ThirdMan",
  },
  description: "Bounded, gated money actions for AI buyer agents — spend caps, an audit trail, and automatic revenue recovery, built on your own Razorpay account.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
