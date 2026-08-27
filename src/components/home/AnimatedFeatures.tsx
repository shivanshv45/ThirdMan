"use client";

import { motion, Variants } from "framer-motion";
import Link from "next/link";
import { Server, FileText, ArrowRightCircle } from "lucide-react";

const containerVariants: Variants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.15,
      delayChildren: 0.2,
    }
  }
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 30 },
  show: { 
    opacity: 1, 
    y: 0, 
    transition: { type: "spring", stiffness: 40, damping: 15 } 
  }
};

export function AnimatedFeatures() {
  return (
    <>
      <section className="border-t border-ink-line relative overflow-hidden bg-ink">
        <div className="absolute top-0 left-[10%] w-full h-[1px] bg-gradient-to-r from-transparent via-accent-wash-strong to-transparent opacity-50" />
        
        <div className="max-w-[var(--shell)] mx-auto px-6 md:px-10 py-[calc(var(--section-y)*1.2)]">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.6 }}
            className="max-w-2xl mb-16"
          >
            <h2 className="font-[family-name:var(--font-display)] text-[var(--t-h1)] font-medium text-on-ink tracking-tight leading-[1.1]">
              One backend. One audit trail.{" "}
              <span className="text-on-ink-dim italic">Three surfaces.</span>
            </h2>
          </motion.div>
          
          <motion.div 
            variants={containerVariants}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-100px" }}
            className="grid md:grid-cols-3 lg:grid-cols-[1.4fr_1fr_1fr] gap-6"
          >
            <motion.div variants={cardVariants}>
              <FeatureCard
                label="Agent API"
                title="A bounded, gated money action"
                body="Every agent gets a cap, a per-transaction limit, and a time window. A purchase over the limit is denied before any money moves, checked against both bounds — arithmetic, not a model guessing."
                featured
                icon={<Server className="w-5 h-5 text-accent-bright" />}
              />
            </motion.div>
            <motion.div variants={cardVariants}>
              <FeatureCard
                label="Merchant dashboard"
                title="A real audit trail"
                body="Every decision — allowed, denied, or escalated — is logged with the reason why, in a sentence a merchant can actually read, not a status code."
                icon={<FileText className="w-5 h-5 text-on-ink-dim" />}
              />
            </motion.div>
            <motion.div variants={cardVariants}>
              <FeatureCard
                label="Revenue recovery"
                title="Automatic, and bounded"
                body="Failed payments are diagnosed, retried within deterministic limits, and written off when they aren't worth chasing — bounded by the same spend caps as everything else."
                icon={<ArrowRightCircle className="w-5 h-5 text-on-ink-dim" />}
              />
            </motion.div>
          </motion.div>
        </div>
      </section>

      <section className="border-t border-ink-line bg-ink-raised relative isolate overflow-hidden">
        {/* Subtle geometric background for the CTA */}
        <div className="absolute inset-0 opacity-[0.03] bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />
        
        <div className="max-w-[var(--shell)] mx-auto px-6 md:px-10 py-20 lg:py-24 flex flex-col md:flex-row items-start md:items-center justify-between gap-10 relative z-10">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, type: "spring" }}
          >
            <h2 className="font-[family-name:var(--font-display)] text-[clamp(1.75rem,3vw,2.5rem)] text-on-ink font-medium max-w-xl leading-[1.1] tracking-tight">
              Connect your Razorpay account and set your first spend cap in a few minutes.
            </h2>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.2, type: "spring" }}
            className="shrink-0"
          >
            <Link
              href="/signup"
              className="group relative inline-flex items-center gap-3 px-8 py-4 rounded-[var(--radius)] bg-on-ink text-ink font-medium overflow-hidden transition-all duration-300 hover:scale-[1.02]"
            >
              <span className="relative z-10">Start building now</span>
              <ArrowRightCircle className="w-4 h-4 relative z-10 opacity-70 group-hover:translate-x-1 transition-transform" />
              <div className="absolute inset-0 bg-white scale-x-0 origin-left group-hover:scale-x-100 transition-transform duration-300 ease-out" />
            </Link>
          </motion.div>
        </div>
      </section>
    </>
  );
}

function FeatureCard({
  label,
  title,
  body,
  featured,
  icon,
}: {
  label: string;
  title: string;
  body: string;
  featured?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div
      className={`relative h-full flex flex-col rounded-[var(--radius-lg)] border p-8 overflow-hidden transition-colors duration-500 ${
        featured 
          ? "border-accent-wash-strong bg-ink hover:bg-ink-raised" 
          : "border-ink-line bg-ink-raised hover:bg-ink"
      }`}
    >
      {featured && (
        <div className="absolute top-0 right-0 w-32 h-32 bg-accent-wash blur-3xl opacity-20 pointer-events-none" />
      )}
      <div className="mb-6 inline-flex items-center justify-center w-10 h-10 rounded-full bg-ink border border-ink-line">
        {icon}
      </div>
      <p className="text-[10px] uppercase tracking-[0.2em] text-accent-bright font-medium mb-3">{label}</p>
      <h3 className={`font-medium text-on-ink mb-3 tracking-tight ${featured ? "text-[var(--t-h3)]" : "text-[var(--t-h4)]"}`}>{title}</h3>
      <p className="text-sm text-on-ink-dim leading-relaxed flex-1">{body}</p>
    </div>
  );
}
