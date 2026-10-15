// `pnpm crypt:rotate` (also run by db:seed when DATA_KEYS is set): seals every plaintext raw_text and bundle with the
// current key and re-seals values under an older key. Batched and idempotent; rows already on the current key are
// not touched.
import type { Db } from "@/db";
import { bundleAad, dataKeys, openText, rawTextAad, sealText } from "@/security/crypt";

const BATCH = 20;

export async function rotateSealed(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<{ sourceRecords: number; bundles: number }> {
  const keys = dataKeys(env);
  if (!keys) throw new Error("DATA_KEYS is not set");
  const current = { startsWith: `enc:${keys.current}:` };
  let sourceRecords = 0;
  for (;;) {
    const rows = await db.sourceRecord.findMany({
      where: { NOT: { rawText: current } },
      select: { id: true, sha256: true, rawText: true },
      take: BATCH,
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      const aad = rawTextAad(r.sha256);
      await db.sourceRecord.update({
        where: { id: r.id },
        data: { rawText: sealText(openText(r.rawText, aad, env), aad, env) },
      });
      sourceRecords++;
    }
  }
  let bundles = 0;
  for (;;) {
    const jobs = await db.transferJob.findMany({
      where: { bundle: { not: null }, bundleSha256: { not: null }, NOT: { bundle: current } },
      select: { id: true, bundle: true, bundleSha256: true },
      take: BATCH,
    });
    if (jobs.length === 0) break;
    for (const j of jobs) {
      const aad = bundleAad(j.bundleSha256!);
      await db.transferJob.update({
        where: { id: j.id },
        data: { bundle: sealText(openText(j.bundle!, aad, env), aad, env) },
      });
      bundles++;
    }
  }
  return { sourceRecords, bundles };
}
