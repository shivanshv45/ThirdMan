import { redirect } from "next/navigation";
import { getSessionMerchant } from "@/lib/auth";
import { AnimatedHero } from "@/components/home/AnimatedHero";
import { AnimatedRefusal } from "@/components/home/AnimatedRefusal";
import { AnimatedFeatures } from "@/components/home/AnimatedFeatures";

export default async function Home() {
  const merchant = await getSessionMerchant();
  if (merchant) redirect("/dashboard");

  return (
    <main className="flex-1">
      <AnimatedHero />
      <AnimatedRefusal />
      <AnimatedFeatures />
    </main>
  );
}
