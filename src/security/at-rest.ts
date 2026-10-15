// AES-256-GCM for derived export bundles. Raw source text stays plaintext: its sha256 is the idempotency key.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc1:";

/** 32-byte key, or null when unset. Throws when the variable is set but not 32 bytes of base64. */
export function readDataKey(
  raw: string | undefined = process.env.MEDISYNC_DATA_KEY,
): Buffer | null {
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("MEDISYNC_DATA_KEY must be 32 bytes, base64");
  return buf;
}

/** Seals plaintext. Refuses to return plaintext when the key is missing or invalid. */
export function sealAtRest(plain: string, key: Buffer | null = readDataKey()): string {
  if (!key) throw new Error("MEDISYNC_DATA_KEY is required to store an export bundle");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/** Opens an enc1 value. A legacy plaintext row (no prefix) is returned unchanged. */
export function openAtRest(stored: string, key: Buffer | null = readDataKey()): string {
  if (!stored.startsWith(PREFIX)) return stored;
  if (!key) throw new Error("MEDISYNC_DATA_KEY is required to read an export bundle");
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(".");
  if (!iv || !tag || !ciphertext) throw new Error("stored bundle is not enc1");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
