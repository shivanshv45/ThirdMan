import { AmbientField } from "./ambient-field";

/**
 * The auth-page backdrop: the same procedural AmbientField used on the
 * landing hero, behind a scrim whose tint drifts continuously between
 * indigo and a warm brown/amber over several minutes — slow enough that
 * no single glance catches it moving, but the whole mood has visibly
 * shifted if you look away and back. Built the same way payloadservice's
 * Hero.tsx builds its own backdrop (full-bleed layer + gradient scrim for
 * text legibility over motion) but as a CSS keyframe tint rather than a
 * licensed video clip — matches this product's existing "no video asset,
 * build it procedurally" precedent (see AmbientField's own docstring),
 * stays reduced-motion safe, and needs no binary asset at all.
 */
export function AuthBackdrop() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-ink" aria-hidden="true">
      <div className="absolute inset-0 opacity-50">
        <AmbientField />
      </div>
      <div className="auth-backdrop-drift absolute inset-0" />
      <div className="absolute inset-0 bg-gradient-to-b from-ink/40 via-ink/70 to-ink" />
    </div>
  );
}
