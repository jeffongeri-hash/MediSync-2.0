// Human-readable transfer fidelity report (Markdown) from a transfer plan. Pure. Lists types, element paths,
// codes and counts only; clinical values and free text are never echoed.
import type { AddReason, ChangeReason, LossReason } from "@/export/diff";
import { completeness } from "@/export/diff";
import { TYPE_ORDER, type TransferPlan } from "@/export/transfer";
import { US_CORE_VERSION } from "@/export/us-core";

export type OpenIssueCount = { stage: string; severity: string; code: string; count: number };
export type FidelityReportInput = {
  plan: TransferPlan;
  dryRun: boolean;
  patient: { sourceSystem: string; sourcePatientId: string };
  /** OPEN review-queue items from the earlier stages (ingest, mapping, dedupe) for this patient. */
  openIssues: OpenIssueCount[];
};

export type TypeSummary = {
  type: string;
  selected: number;
  exported: number;
  excluded: number;
  sourceLeaves: number;
  kept: number;
  changed: number;
  lost: number;
  added: number;
  completeness: number;
};

/** Per-type and overall counts (also stored as transfer_jobs.summary). */
export function summarize(plan: TransferPlan): { overall: TypeSummary; byType: TypeSummary[] } {
  const by = new Map<string, TypeSummary>();
  const blank = (type: string): TypeSummary => ({
    type,
    selected: 0,
    exported: 0,
    excluded: 0,
    sourceLeaves: 0,
    kept: 0,
    changed: 0,
    lost: 0,
    added: 0,
    completeness: 1,
  });
  const overall = blank("all");
  for (const o of plan.outcomes) {
    const t = by.get(o.resourceType) ?? blank(o.resourceType);
    by.set(o.resourceType, t);
    for (const s of [t, overall]) {
      s.selected++;
      s[o.exported ? "exported" : "excluded"]++;
      s.sourceLeaves += o.diff.sourceLeaves;
      s.kept += o.diff.kept;
      s.changed += o.diff.changed.length;
      s.lost += o.diff.lost.length;
      s.added += o.diff.added.length;
    }
  }
  const byType = [...by.values()].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type as never) - TYPE_ORDER.indexOf(b.type as never),
  );
  for (const s of [...byType, overall]) s.completeness = completeness(s);
  return { overall, byType };
}

const LOSS: Record<LossReason, (target?: string) => string> = {
  reference_outside_scope: (t) =>
    `reference to ${t}: type not in the canonical model (display kept)`,
  reference_not_exported: (t) => `reference to ${t}: target not exported`,
  resource_excluded: () => "resource excluded (fails a US Core mandatory check)",
  unexplained: () => "**unexplained** (pipeline bug)",
};
const CHANGE: Record<ChangeReason, string> = {
  reference_rewritten: "reference rewritten to the bundle entry",
  system_normalized: "code system URI normalized",
  code_normalized: "code normalized",
  unit_normalized: "unit normalized to UCUM",
  value_changed: "**value changed** (unexpected)",
};
const ADD: Record<AddReason, string> = {
  display_filled: "display filled from the terminology table",
  ucum_coded: "UCUM system/code added",
  reference_note: "note that the referenced record was not sent",
  other: "other",
};

const n = (x: number) => x.toLocaleString("en-US");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const code = (s: string) => `\`${s}\``;
/** A rule label such as "reasonCode|reasonReference" as table-safe text ("|" would split the cell). */
const label = (s: string) => s.split("|").map(code).join(" or ");
/** Markdown table; columns whose cells are all numbers are right-aligned. */
function table(head: string[], rows: string[][]): string {
  const numeric = head.map(
    (_, i) => rows.length > 0 && rows.every((r) => /^\**[\d,.]+%?\**$/.test(r[i] ?? "")),
  );
  return [
    `| ${head.join(" | ")} |`,
    `|${numeric.map((x) => (x ? "---:" : "---")).join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

type Group = { key: string[]; count: number; examples: Set<string> };
function grouped<T>(
  items: T[],
  key: (t: T) => string[],
  example?: (t: T) => string | undefined,
): Group[] {
  const m = new Map<string, Group>();
  for (const it of items) {
    const k = key(it);
    const id = k.join("\u0000");
    const g = m.get(id) ?? { key: k, count: 0, examples: new Set<string>() };
    m.set(id, g);
    g.count++;
    const ex = example?.(it);
    if (ex && g.examples.size < 2) g.examples.add(ex);
  }
  return [...m.values()].sort(
    (a, b) => b.count - a.count || (a.key.join() < b.key.join() ? -1 : 1),
  );
}

export function renderFidelityReport({
  plan,
  dryRun,
  patient,
  openIssues,
}: FidelityReportInput): string {
  const { overall, byType } = summarize(plan);
  const o = plan.outcomes;
  const errors = plan.issues.filter((i) => i.severity === "ERROR").length;
  const warnings = plan.issues.filter((i) => i.severity === "WARNING").length;
  const withheld = o.reduce((s, x) => s + x.withheldDerivedCodings, 0);
  const out: string[] = [];
  const push = (...blocks: string[]) => out.push(...blocks.flatMap((b) => [b, ""]));

  push(
    "# Transfer fidelity report",
    `Patient ${code(patient.sourcePatientId)} from ${code(patient.sourceSystem)} → US Core ${US_CORE_VERSION} FHIR R4 transaction Bundle. ` +
      `${dryRun ? "**Dry run**: nothing was kept or sent." : "**Export**: the bundle was produced and stored with the job."} ` +
      `Export timestamp ${plan.exportedAt}.`,
  );
  if (plan.blockers.length)
    push("## Blocked", "No bundle can be produced:", ...plan.blockers.map((b) => `- ${b}`));

  push(
    "## Summary",
    table(
      ["Measure", "Value"],
      [
        [
          "Completeness (source elements transferred)",
          `**${pct(overall.completeness)}** (${n(overall.kept)} kept + ${n(overall.changed)} changed of ${n(overall.sourceLeaves)})`,
        ],
        [
          "Lost elements",
          `${n(overall.lost)} (${pct(overall.sourceLeaves ? overall.lost / overall.sourceLeaves : 0)})`,
        ],
        [
          "Resources",
          `${n(overall.selected)} selected · ${n(overall.exported)} exported · ${n(overall.excluded)} excluded`,
        ],
        ["Provenance resources added", n(plan.provenanceCount)],
        [
          "Bundle",
          plan.bundleText
            ? `${n(plan.bundle!.entry.length)} entries · ${n(Math.round(Buffer.byteLength(plan.bundleText) / 1024))} KiB · sha256 ${code(plan.bundleSha256!)}`
            : "not produced",
        ],
        ["Conformance (local US Core checks)", `${n(errors)} errors · ${n(warnings)} warnings`],
        [
          "Open review-queue entries from earlier stages",
          n(openIssues.reduce((s, i) => s + i.count, 0)),
        ],
      ],
    ),
  );

  const byReason = <T extends { reason: string }>(xs: T[], names: Record<string, string>) =>
    grouped(xs, (x) => [x.reason])
      .map((g) => `${names[g.key[0]!] ?? g.key[0]}: ${n(g.count)}`)
      .join(", ");
  const lostItems = o.flatMap((x) => x.diff.lost);
  const lostTargets = [
    ...new Set(lostItems.filter((l) => l.reason.startsWith("reference_")).map((l) => l.example!)),
  ].sort();
  const dupOnlyCount = o.reduce(
    (s, x) => s + x.duplicateOnly.reduce((t, d) => t + (d.patterns?.length ?? 0), 0),
    0,
  );
  push(
    "## Findings",
    [
      `- **Lost**: ${lostItems.length ? `${n(lostItems.length)} elements (${byReason(lostItems, { reference_outside_scope: "references to types outside the canonical model", reference_not_exported: "references to resources not exported", resource_excluded: "in excluded resources", unexplained: "unexplained" })})` : "nothing"}${lostTargets.length ? `. Referenced types not sent: ${lostTargets.join(", ")}; their display text is kept.` : "."}`,
      `- **Changed**: ${
        overall.changed
          ? `${n(overall.changed)} elements (${byReason(
              o.flatMap((x) => x.diff.changed),
              CHANGE,
            )})`
          : "nothing"
      }.`,
      `- **Excluded**: ${overall.excluded ? `${n(overall.excluded)} resources fail a US Core mandatory check (see Conformance)` : "no resource fails a US Core mandatory check"}.`,
      `- **Not merged**: ${dupOnlyCount ? `${n(dupOnlyCount)} element(s) exist only in a linked duplicate from another format (see below)` : "no linked duplicate has an element its primary lacks"}.`,
    ].join("\n"),
  );

  push(
    "## By resource type",
    "Completeness = (kept + changed) / source elements, counted on leaf elements of each source resource as received.",
    table(
      [
        "Resource type",
        "Selected",
        "Exported",
        "Excluded",
        "Source elements",
        "Kept",
        "Changed",
        "Lost",
        "Added",
        "Completeness",
      ],
      [...byType, overall].map((s) => [
        s.type === "all" ? "**All**" : s.type,
        n(s.selected),
        n(s.exported),
        n(s.excluded),
        n(s.sourceLeaves),
        n(s.kept),
        n(s.changed),
        n(s.lost),
        n(s.added),
        pct(s.completeness),
      ]),
    ),
  );

  const lost = grouped(
    o.flatMap((x) => x.diff.lost.map((l) => ({ type: x.resourceType, ...l }))),
    (l) => [l.type, l.pattern, LOSS[l.reason](l.example)],
  );
  push(
    "## What would be lost",
    lost.length
      ? table(
          ["Resource type", "Element", "Reason", "Count"],
          lost.map((g) => [g.key[0]!, code(g.key[1]!), g.key[2]!, n(g.count)]),
        )
      : "Nothing: every source element has a counterpart in the export.",
  );

  const changed = grouped(
    o.flatMap((x) => x.diff.changed.map((c) => ({ type: x.resourceType, ...c }))),
    (c) => [c.type, c.pattern, CHANGE[c.reason]],
    (c) => c.example,
  );
  push(
    "## What would change",
    changed.length
      ? table(
          ["Resource type", "Element", "Change", "Count", "Example"],
          changed.map((g) => [
            g.key[0]!,
            code(g.key[1]!),
            g.key[2]!,
            n(g.count),
            [...g.examples].map(code).join("; "),
          ]),
        )
      : "Nothing: every transferred element keeps its source value.",
  );

  const added = grouped(
    o.flatMap((x) => x.diff.added.map((a) => ({ type: x.resourceType, ...a }))),
    (a) => [a.type, a.pattern, ADD[a.reason]],
  );
  push(
    "## Added by the transfer",
    `- ${n(plan.provenanceCount)} Provenance resources (one per exported resource: source system, MediSync as transmitter, source documents by sha256).`,
    `- Every exported resource declares its versioned US Core profile in ${code("meta.profile")}.`,
    `- ${n(withheld)} derived ICD-10-CM codings were withheld: the local SNOMED CT crosswalk is unverified, so derived codes are never sent.`,
    ...(added.length ? [""] : ["- No elements were added to the clinical resources themselves."]),
  );
  if (added.length)
    push(
      table(
        ["Resource type", "Element", "Addition", "Count"],
        added.map((g) => [g.key[0]!, code(g.key[1]!), g.key[2]!, n(g.count)]),
      ),
    );

  const dupRows = o.flatMap((x) => x.duplicateOnly.map((d) => ({ type: x.resourceType, ...d })));
  const dupOnly = grouped(
    dupRows.flatMap((d) => (d.patterns ?? []).map((p) => ({ ...d, p }))),
    (d) => [d.type, d.format, d.p],
  );
  const crossType = grouped(
    dupRows.filter((d) => !d.patterns),
    (d) => [d.type, d.format, d.resourceType],
  );
  push(
    "## Available only in a linked duplicate (not exported)",
    `Primary rows are exported; linked cross-format duplicates are cited in Provenance but never merged in. ` +
      `${n(dupRows.length)} duplicates are linked to the exported rows.`,
    dupOnly.length
      ? table(
          ["Resource type", "Duplicate format", "Element", "Rows"],
          dupOnly.map((g) => [g.key[0]!, g.key[1]!, code(g.key[2]!), n(g.count)]),
        )
      : "No duplicate carries an element its primary lacks.",
  );
  if (crossType.length)
    push(
      "Duplicates of another resource type are not compared element by element:",
      table(
        ["Primary type", "Duplicate format", "Duplicate type", "Rows"],
        crossType.map((g) => [g.key[0]!, g.key[1]!, g.key[2]!, n(g.count)]),
      ),
    );

  const profiles = grouped(o, (x) => [x.profile ?? "(none: base FHIR R4)"]);
  const excluded = o.filter((x) => !x.exported);
  const ms = grouped(
    o
      .filter((x) => x.exported)
      .flatMap((x) => x.mustSupportMissing.map((m) => ({ type: x.resourceType, m }))),
    (x) => [x.type, x.m],
  );
  push(
    `## Conformance (US Core ${US_CORE_VERSION}, local checks)`,
    table(
      ["Profile", "Resources"],
      profiles.map((g) => [code(g.key[0]!), n(g.count)]),
    ),
  );
  push(
    "Excluded (a mandatory element is missing):",
    excluded.length
      ? table(
          ["Resource type", "Id", "Missing"],
          excluded.map((x) => [x.resourceType, code(x.fhirId), x.missing.map(label).join(", ")]),
        )
      : "None.",
  );
  push(
    "Must-support elements absent (exported anyway):",
    ms.length
      ? table(
          ["Resource type", "Element", "Resources"],
          ms.map((g) => [g.key[0]!, label(g.key[1]!), n(g.count)]),
        )
      : "None.",
  );

  push(
    "## Open review-queue items (ingest, mapping, dedupe)",
    openIssues.length
      ? table(
          ["Stage", "Severity", "Code", "Count"],
          openIssues.map((i) => [i.stage, i.severity, code(i.code), n(i.count)]),
        )
      : "None.",
  );

  push(
    "## Caveats",
    `- The US Core ${US_CORE_VERSION} profile choice, profile URLs and element rules are from memory: hl7.org is blocked by the network policy, so the IG was not checked (docs/NOTES.md). When unsure whether an element is mandatory, it is checked as must-support, so a table error can only cause a warning.`,
    "- Terminology tables and the SNOMED CT to ICD-10-CM crosswalk are unverified (Phase 2).",
    `- ${code("id")}, ${code("meta")} and ${code("resourceType")} are not scored: entries are POSTs, so the target assigns ids; source ids and documents are in Provenance.`,
  );
  return `${out.join("\n").trimEnd()}\n`;
}
