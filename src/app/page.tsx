import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { CodaHero } from "@/components/home/CodaHero";
import { Surfaces } from "@/components/home/Surfaces";
import { RefusalSection } from "@/components/home/RefusalSection";
import { ProofSection } from "@/components/home/ProofSection";
import { Footer } from "@/components/home/Footer";

export default async function Home() {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  return (
    <main className="coda-theme flex-1 min-h-screen relative">
      <CodaHero />
      <Surfaces />
      <RefusalSection />
      <ProofSection />
      <Footer />
    </main>
  );
}
