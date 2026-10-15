import { describe, expect, it } from "vitest";
import { openAtRest, readDataKey, sealAtRest } from "@/security/at-rest";

const key = Buffer.alloc(32, 7);

describe("sealAtRest", () => {
  it("round-trips and does not store the plaintext", () => {
    const sealed = sealAtRest('{"resourceType":"Patient","name":"Corie618"}', key);
    expect(sealed.startsWith("enc1:")).toBe(true);
    expect(sealed).not.toContain("Corie618");
    expect(openAtRest(sealed, key)).toBe('{"resourceType":"Patient","name":"Corie618"}');
    expect(sealAtRest("same", key)).not.toBe(sealAtRest("same", key));
  });

  it("refuses to store plaintext without a key", () => {
    expect(() => sealAtRest("bundle", null)).toThrow(/MEDISYNC_DATA_KEY is required/);
  });

  it("leaves a legacy plaintext row readable and rejects a bad key length", () => {
    expect(openAtRest('{"ok":true}', null)).toBe('{"ok":true}');
    expect(() => readDataKey("aaaa")).toThrow(/32 bytes/);
    expect(readDataKey(undefined)).toBeNull();
    expect(readDataKey(key.toString("base64"))).toEqual(key);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = sealAtRest("bundle", key);
    const flipped = sealed.slice(0, -1) + (sealed.endsWith("A") ? "B" : "A");
    expect(() => openAtRest(flipped, key)).toThrow();
  });
});
