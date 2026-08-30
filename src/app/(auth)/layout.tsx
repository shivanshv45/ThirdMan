import Link from "next/link";
import { BackgroundVideo } from "@/components/ui/background-video";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="relative isolate overflow-hidden flex flex-col items-center justify-center min-h-screen px-6 py-16"
      style={{ background: "#000", color: "#ededed" }}
    >
      {/* Background video that persists across /login and /signup without remounting */}
      <BackgroundVideo srcWebm="/video/slate.webm" srcMp4="/video/slate.mp4" />

      {/* ← Home link */}
      <Link
        href="/"
        className="absolute top-7 left-7 z-20 flex items-center gap-1.5 text-[13px] font-medium"
        style={{ color: "#888" }}
      >
        <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 1L1 6l5 5" /></svg>
        Home
      </Link>

      {/* Page content */}
      {children}
    </main>
  );
}
