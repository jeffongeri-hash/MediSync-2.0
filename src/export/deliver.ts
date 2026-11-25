// Delivery of an approved transfer to a receiving EHR (Phase 7): the configured targets and one FHIR transaction POST.
// Only loopback targets are accepted. A real EHR needs SMART Backend Services auth and its vendor's review first
// (docs/DECISIONS.md), so a remote URL is refused at configuration, never sent to. Errors name variables and codes,
// never values or the target's diagnostics (which may echo record content).
import { z } from "zod";

/** A receiving EHR: TRANSFER_TARGETS name, a label for the UI, and its FHIR base URL (no trailing slash). */
export type TransferTarget = { name: string; label: string; url: string };

export class TransferTargetError extends Error {}

const TARGET_NAME = /^[a-z][a-z0-9-]{0,19}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** TRANSFER_<NAME>_<FIELD> for a target name ("ehr-b" -> TRANSFER_EHR_B_URL). */
export const targetVar = (name: string, field: "URL" | "LABEL") =>
  `TRANSFER_${name.toUpperCase().replace(/-/g, "_")}_${field}`;

/** TRANSFER_TARGETS=ehrb with TRANSFER_EHRB_URL (a FHIR base) and optional TRANSFER_EHRB_LABEL. Unset: none. */
export function transferTargets(
  env: Record<string, string | undefined> = process.env,
): TransferTarget[] {
  const names = (env.TRANSFER_TARGETS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.map((name) => {
    if (!TARGET_NAME.test(name))
      throw new TransferTargetError("TRANSFER_TARGETS holds an invalid name (a-z, 0-9, -)");
    const v = targetVar(name, "URL");
    const raw = (env[v] ?? "").trim().replace(/\/+$/, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new TransferTargetError(`set ${v} to the target's FHIR base URL (see .env.example)`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new TransferTargetError(`${v} must be an http(s) URL`);
    if (!LOOPBACK.has(url.hostname))
      throw new TransferTargetError(
        `${v} is not a loopback test server; sending to a real EHR is off (docs/DECISIONS.md)`,
      );
    return { name, label: env[targetVar(name, "LABEL")]?.trim() || name, url: raw };
  });
}

/** What the target answered. Ids and counts only. */
export type Delivery = {
  httpStatus: number | null;
  /** Resources the target created, per type, from the response locations. */
  created: Record<string, number>;
  /** The id the target assigned to the Patient. */
  targetPatientId: string | null;
  error: string | null;
};

const responseSchema = z.looseObject({
  resourceType: z.literal("Bundle"),
  type: z.literal("transaction-response"),
  entry: z.array(
    z.looseObject({
      response: z.looseObject({ status: z.string(), location: z.string().optional() }),
    }),
  ),
});
const outcomeCodes = z.looseObject({
  resourceType: z.literal("OperationOutcome"),
  issue: z.array(z.looseObject({ code: z.string() })),
});
const LOCATION = /^(?:.*\/)?([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/[^/]+)?$/;

/**
 * POSTs a transaction Bundle to the target's base and checks the answer: a transaction-response with one created
 * entry per entry sent. A failure comes back in `error`, not as a throw.
 */
export async function postTransaction(
  target: TransferTarget,
  bundleText: string,
  { fetchFn = fetch, timeoutMs = 30_000 }: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<Delivery> {
  const sent = (JSON.parse(bundleText) as { entry: unknown[] }).entry.length;
  const out: Delivery = { httpStatus: null, created: {}, targetPatientId: null, error: null };
  let res: Response;
  try {
    res = await fetchFn(target.url, {
      method: "POST",
      headers: { "content-type": "application/fhir+json", accept: "application/fhir+json" },
      body: bundleText,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    out.error = `could not reach ${target.name} (${name === "TimeoutError" ? "timed out" : name})`;
    return out;
  }
  out.httpStatus = res.status;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const codes = outcomeCodes.safeParse(body);
    out.error = `${target.name} answered HTTP ${res.status}${
      codes.success ? ` (${codes.data.issue.map((i) => i.code).join(", ")})` : ""
    }`;
    return out;
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    out.error = `${target.name} did not answer with a transaction-response Bundle`;
    return out;
  }
  if (parsed.data.entry.length !== sent) {
    out.error = `${target.name} answered ${parsed.data.entry.length} entries for ${sent} sent`;
    return out;
  }
  for (const e of parsed.data.entry) {
    const m = LOCATION.exec(e.response.location ?? "");
    if (!/^20[01]\b/.test(e.response.status) || !m) {
      out.error = `${target.name} did not create every entry (status ${e.response.status.slice(0, 40)})`;
      return out;
    }
    out.created[m[1]!] = (out.created[m[1]!] ?? 0) + 1;
    if (m[1] === "Patient") out.targetPatientId = m[2]!;
  }
  return out;
}
