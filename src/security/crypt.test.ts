import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dataKeys, keyIdOf, openText, sealText } from "@/security/crypt";

const k = () => randomBytes(32).toString("base64");
const A = k();
const B = k();
const envA = { DATA_KEYS: `a:${A}` };
const envAB = { DATA_KEYS: `a:${A},b:${B}`, DATA_KEY_ID: "b" };
const TEXT = '{"resourceType":"Bundle","entry":[{"resource":{"name":"Jesús618"}}]}';

describe("encryption at rest", () => {
  it("round-trips text and records the key id, never the plaintext", () => {
    const sealed = sealText(TEXT, "row:1", envA);
    expect(sealed.startsWith("enc:a:")).toBe(true);
    expect(sealed).not.toContain("Jes");
    expect(keyIdOf(sealed)).toBe("a");
    expect(openText(sealed, "row:1", envA)).toBe(TEXT);
    expect(sealText(TEXT, "row:1", envA)).not.toBe(sealed);
  });

  it("refuses a value moved to another row, tampered, or opened without its key", () => {
    const sealed = sealText(TEXT, "row:1", envA);
    expect(() => openText(sealed, "row:2", envA)).toThrow();
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    expect(() => openText(flipped, "row:1", envA)).toThrow();
    expect(() => openText(sealed, "row:1", { DATA_KEYS: `b:${B}` })).toThrow(/No data key "a"/);
    expect(() => openText(sealed, "row:1", {})).toThrow(/No data key/);
  });

  it("seals new values with DATA_KEY_ID and still opens values under an older key", () => {
    const old = sealText(TEXT, "row:1", envA);
    const fresh = sealText(TEXT, "row:1", envAB);
    expect(keyIdOf(fresh)).toBe("b");
    expect(openText(old, "row:1", envAB)).toBe(TEXT);
    expect(openText(fresh, "row:1", envAB)).toBe(TEXT);
  });

  it("passes plaintext through, and stores plaintext without keys only outside production", () => {
    expect(openText(TEXT, "row:1", envA)).toBe(TEXT);
    expect(sealText(TEXT, "row:1", { NODE_ENV: "test" })).toBe(TEXT);
    expect(() => sealText(TEXT, "row:1", { NODE_ENV: "production" })).toThrow(/DATA_KEYS/);
  });

  it("rejects malformed key settings", () => {
    expect(() => dataKeys({ DATA_KEYS: "a:short" })).toThrow(/32 random bytes/);
    expect(() => dataKeys({ DATA_KEYS: `bad id:${A}` })).toThrow();
    expect(() => dataKeys({ DATA_KEYS: `a:${A}`, DATA_KEY_ID: "c" })).toThrow(/DATA_KEY_ID/);
    expect(dataKeys({})).toBeNull();
  });
});
