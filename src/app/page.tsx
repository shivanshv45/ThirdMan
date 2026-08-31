import { getSessionMerchant } from "@/lib/auth";
import { CodaHero } from "@/components/home/CodaHero";
import { GateSequence } from "@/components/home/GateSequence";
import { SurfaceMarquee } from "@/components/home/SurfaceMarquee";
import { SplitSection } from "@/components/home/SplitSection";
import { PlatformSection } from "@/components/home/PlatformSection";
import { ProofSection } from "@/components/home/ProofSection";
import { Footer } from "@/components/home/Footer";

/**
 * Section order is deliberate: the hero states the claim, GateSequence
 * proves it mechanically (scroll-pinned, one bound at a time), the marquee
 * shows where that gate is reachable from, the split names what the model
 * is and isn't allowed to touch, PlatformSection covers everything built
 * past the original four surfaces (the autonomous agent, returns desk,
 * onboarding, control layer), and the proof grid lands the numbers.
 *
 * GateSequence through ProofSection share one .coda-dark-band wrapper so
 * the dark run reads as a single plate rather than four bands stacked —
 * the light paper theme returns only above it, in the hero.
 */
export default async function Home() {
  const merchant = await getSessionMerchant();

  return (
    <main className="coda-theme flex-1 min-h-screen relative">
      <CodaHero signedIn={!!merchant} />

      <div className="coda-dark-band">
        <GateSequence />
        <SurfaceMarquee signedIn={!!merchant} />
        <SplitSection />
        <PlatformSection signedIn={!!merchant} />
        <ProofSection />
      </div>

      <Footer signedIn={!!merchant} />
    </main>
  );
}
