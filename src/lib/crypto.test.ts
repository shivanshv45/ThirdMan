import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "@/lib/crypto";

describe("encrypt/decrypt", () => {
  it("round-trips a plaintext value", () => {
    const plaintext = "rzp_test_fixturevalue123";
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const plaintext = "same-secret-value";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);

    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });

  it("throws on malformed ciphertext instead of returning garbage", () => {
    expect(() => decrypt("not-a-valid-ciphertext")).toThrow(/malformed/i);
  });

  it("throws when the auth tag doesn't match tampered ciphertext", () => {
    const ciphertext = encrypt("a secret");
    const [iv, tag, data] = ciphertext.split(":");

    // Flip a byte in the ciphertext segment — GCM's auth tag must reject this.
    const tampered = Buffer.from(data, "base64");
    tampered[0] = tampered[0] ^ 0xff;
    const tamperedCiphertext = [iv, tag, tampered.toString("base64")].join(":");

    expect(() => decrypt(tamperedCiphertext)).toThrow();
  });
});
