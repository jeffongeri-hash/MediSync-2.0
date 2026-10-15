// Encryption at rest for the PHI text columns: source_records.raw_text and transfer_jobs.bundle. AES-256-GCM through
// the session sealer, stored as `enc:<keyId>:<sealed>`. The row's sha256 of the plaintext is the associated data, so
// a value cannot be moved to another row. Keys: DATA_KEYS="<id>:<base64 32 bytes>,..." and DATA_KEY_ID (the key new
// values use; default: the first listed). Older keys stay listed until `pnpm crypt:rotate` has re-sealed their rows.
import { seal, unseal } from "@/smart/crypto";

export type DataKeys = { current: string; keys: Map<string, Buffer> };

type Env = Record<string, string | undefined>;

const PREFIX = "enc:";

export function dataKeys(env: Env = process.env): DataKeys | null {
  const list = env.DATA_KEYS?.trim();
  if (!list) return null;
  const keys = new Map<string, Buffer>();
  for (const part of list.split(",")) {
    const m = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9+/=]+)$/.exec(part.trim());
    const key = m ? Buffer.from(m[2]!, "base64") : null;
    if (!m || key?.length !== 32)
      throw new Error("DATA_KEYS must be comma-separated <id>:<base64 of 32 random bytes>");
    keys.set(m[1]!, key);
  }
  const current = env.DATA_KEY_ID?.trim() || [...keys.keys()][0]!;
  if (!keys.has(current)) throw new Error("DATA_KEY_ID names no key in DATA_KEYS");
  return { current, keys };
}

export const rawTextAad = (sha256: string) => `source_records.raw_text:${sha256}`;
export const bundleAad = (sha256: string) => `transfer_jobs.bundle:${sha256}`;

/** The key id a stored value was sealed with, or null for plaintext. */
export const keyIdOf = (stored: string): string | null =>
  stored.startsWith(PREFIX)
    ? stored.slice(PREFIX.length, stored.indexOf(":", PREFIX.length))
    : null;

/**
 * Seals with the current key. Without DATA_KEYS the text is stored as is outside production (synthetic data in
 * development and tests); a production build refuses to store it.
 */
export function sealText(plain: string, aad: string, env: Env = process.env): string {
  const keys = dataKeys(env);
  if (!keys) {
    if (env.NODE_ENV === "production")
      throw new Error("DATA_KEYS is not set: refusing to store patient data unencrypted");
    return plain;
  }
  return `${PREFIX}${keys.current}:${seal(plain, keys.keys.get(keys.current)!, aad)}`;
}

/** Opens a stored value. Plaintext (written before encryption, or without keys) is returned as is. */
export function openText(stored: string, aad: string, env: Env = process.env): string {
  const id = keyIdOf(stored);
  if (id === null) return stored;
  const key = dataKeys(env)?.keys.get(id);
  if (!key) throw new Error(`No data key "${id}" in DATA_KEYS`);
  const plain = unseal(stored.slice(PREFIX.length + id.length + 1), key, aad);
  if (typeof plain !== "string") throw new Error("Sealed value is not text");
  return plain;
}
