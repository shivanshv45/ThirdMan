import { ImageResponse } from "next/og";

export const alt = "ThirdMan — Agentic Commerce for Razorpay Merchants";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0a0d0f",
          color: "#eef2f4",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 40 }}>
          <div style={{ width: 20, height: 20, borderRadius: 4, background: "#4fd1c5" }} />
          <div style={{ fontSize: 32, color: "#93a1ac", letterSpacing: 2, textTransform: "uppercase" }}>
            For Razorpay merchants
          </div>
        </div>
        <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.15, maxWidth: 1000 }}>
          Let AI agents buy from your store — bounded, gated, and auditable.
        </div>
        <div style={{ display: "flex", gap: 24, marginTop: 56 }}>
          {[
            { label: "Allowed", color: "#3ecf8e" },
            { label: "Denied", color: "#f2545b" },
            { label: "Escalated", color: "#e8a13d" },
          ].map((d) => (
            <div
              key={d.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 24,
                color: d.color,
                border: `1px solid ${d.color}55`,
                borderRadius: 999,
                padding: "10px 22px",
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: 999, background: d.color }} />
              {d.label}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
