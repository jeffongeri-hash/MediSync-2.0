// Builds the frozen Phase 4 eval set from the seeded database: fixtures/eval/patients.json (each patient's Bundle and
// C-CDA rows for reconcile, mapped, meta and narrative stripped) and fixtures/eval/cases.json (20 cases).
// Usage: pnpm eval:build   (after pnpm db:seed). Synthetic data only.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCases, type EvalPatient } from "@/ai/eval-cases";
import { createDb } from "@/db";
import { lastEncounter, loadSourceRows } from "@/reconcile/load";
import { defaultCutoff } from "@/reconcile/rows";

async function main() {
  const db = createDb();
  try {
    const patients = await db.patient.findMany({
      orderBy: [{ displayName: "asc" }, { id: "asc" }],
    });
    const out: EvalPatient[] = [];
    for (const [i, p] of patients.entries()) {
      const last = await lastEncounter(db, p.id);
      if (!last) throw new Error(`patient ${p.id} has no encounters`);
      const rows = (await loadSourceRows(db, p.id)).map((r) => {
        const { meta: _meta, text: _text, ...resource } = r.resource;
        return { ...r, resource };
      });
      out.push({
        key: `p${String(i + 1).padStart(2, "0")}`,
        label: p.displayName ?? p.id,
        cutoff: defaultCutoff(last).toISOString(),
        rows,
      });
    }
    const cases = buildCases(out);
    const dir = join(process.cwd(), "fixtures/eval");
    writeFileSync(join(dir, "patients.json"), `${JSON.stringify(out)}\n`);
    writeFileSync(join(dir, "cases.json"), `${JSON.stringify(cases, null, 1)}\n`);
    const injected = cases.flatMap((c) => c.perturbations.map((p) => p.type));
    console.log(
      `eval:build: ${out.length} patients, ${out.reduce((n, p) => n + p.rows.length, 0)} rows, ${cases.length} cases, ` +
        `${injected.length} injected changes (${[...new Set(injected)].map((t) => `${t} ${injected.filter((x) => x === t).length}`).join(", ")})`,
    );
  } finally {
    await db.$disconnect();
  }
}

void main();
