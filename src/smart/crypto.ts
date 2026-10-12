// Session secrets: the cookie carries a random token, the database row is keyed by its sha256, and the SMART state
// (tokens, PKCE verifier) is sealed with AES-256-GCM. A database dump alone yields neither a cookie nor a token.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

export const newSessionToken = () => randomBytes(32).toString("base64url");

export const sessionIdOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** `v1.<iv>.<tag>.<ciphertext>`, base64url parts. The session id is bound as associated data. */
export function seal(value: unknown, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

/** Throws on a wrong key, wrong session id, or any tampering. */
export function unseal<T = unknown>(sealed: string, key: Buffer, aad: string): T {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined)
    throw new Error("Unsupported sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(body, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(text) as T;
}
