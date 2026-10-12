// SMART sessions: one smart_sessions row per launch, found through an httpOnly cookie. fhirclient keeps its
// authorization state in a storage object; ours seals the whole map into the row, so tokens never reach the browser.
import type { Db } from "@/db";
import type { LaunchKind } from "@/smart/config";
import { newSessionToken, seal, sessionIdOf, unseal } from "@/smart/crypto";

export const SESSION_COOKIE = "medisync_smart";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type SmartSession = NonNullable<Awaited<ReturnType<Db["smartSession"]["findUnique"]>>>;

export async function createSession(
  db: Db,
  opts: { launchType: LaunchKind; iss: string; now?: Date },
): Promise<{ token: string; id: string }> {
  const token = newSessionToken();
  const id = sessionIdOf(token);
  const now = opts.now ?? new Date();
  await db.smartSession.create({
    data: {
      id,
      launchType: opts.launchType,
      iss: opts.iss,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
  });
  return { token, id };
}

/** The live session for a cookie value, or null (no cookie, unknown, or expired). */
export async function findSession(
  db: Db,
  token: string | undefined | null,
  now = new Date(),
): Promise<SmartSession | null> {
  if (!token || token.length > 200) return null;
  const row = await db.smartSession.findUnique({ where: { id: sessionIdOf(token) } });
  return row && row.expiresAt > now ? row : null;
}

/** fhirclient's storage contract (get/set/unset, async) over the sealed `state_enc` column of one session. */
export class SessionStorage {
  private map: Record<string, unknown> | null = null;

  constructor(
    private readonly db: Db,
    private readonly sessionId: string,
    private readonly key: Buffer,
  ) {}

  private async load(): Promise<Record<string, unknown>> {
    if (this.map) return this.map;
    const row = await this.db.smartSession.findUniqueOrThrow({
      where: { id: this.sessionId },
      select: { stateEnc: true },
    });
    this.map = row.stateEnc
      ? unseal<Record<string, unknown>>(row.stateEnc, this.key, this.sessionId)
      : {};
    return this.map;
  }

  private async save(): Promise<void> {
    await this.db.smartSession.update({
      where: { id: this.sessionId },
      data: { stateEnc: seal(this.map ?? {}, this.key, this.sessionId) },
    });
  }

  async get(key: string): Promise<unknown> {
    return (await this.load())[key];
  }

  async set(key: string, value: unknown): Promise<unknown> {
    (await this.load())[key] = value;
    await this.save();
    return value;
  }

  async unset(key: string): Promise<boolean> {
    const map = await this.load();
    if (!(key in map)) return false;
    delete map[key];
    await this.save();
    return true;
  }
}

/** Set-Cookie value. Lax so the authorization server's top-level redirect back to the callback carries it. */
export function sessionCookie(token: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
