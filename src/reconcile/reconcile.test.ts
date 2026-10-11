import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/mapping/systems";
import { buildReconciliation, distinctFlags, type Reconciliation } from "@/reconcile/build";
import { allergenProfile, drugProfile } from "@/reconcile/drugs";
import { currentAsOf, defaultCutoff, toReconRow, type SourceRow } from "@/reconcile/rows";

const CUTOFF = new Date("2025-01-01T00:00:00Z");
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

function condition(
  format: SourceRow["format"],
  code: string,
  display: string,
  o: { status?: string; onset?: string; abated?: string; dupOf?: string; system?: string } = {},
): SourceRow {
  const system = o.system ?? SYSTEM.SNOMED;
  return {
    id: id(),
    resourceType: "Condition",
    format,
    duplicateOfId: o.dupOf ?? null,
    codeSystem: system,
    code,
    resource: {
      resourceType: "Condition",
      clinicalStatus: { coding: [{ code: o.status ?? "active" }] },
      code: { coding: [{ system, code, display }] },
      onsetDateTime: o.onset ?? "2020-03-01T10:00:00Z",
      ...(o.abated ? { abatementDateTime: o.abated } : {}),
    },
  };
}

function med(
  format: SourceRow["format"],
  code: string,
  o: { status?: string; start?: string; dose?: number; dupOf?: string } = {},
): SourceRow {
  const start = o.start ?? "2020-03-01T10:00:00Z";
  const dosage =
    o.dose === undefined ? [] : [{ doseAndRate: [{ doseQuantity: { value: o.dose } }] }];
  const medicationCodeableConcept = { coding: [{ system: SYSTEM.RXNORM, code }] };
  return {
    id: id(),
    resourceType: format === "CCDA" ? "MedicationStatement" : "MedicationRequest",
    format,
    duplicateOfId: o.dupOf ?? null,
    codeSystem: SYSTEM.RXNORM,
    code,
    resource:
      format === "CCDA"
        ? {
            status: o.status ?? "active",
            medicationCodeableConcept,
            effectivePeriod: { start },
            dosage,
          }
        : {
            status: o.status ?? "active",
            medicationCodeableConcept,
            authoredOn: start,
            dosageInstruction: dosage,
          },
  };
}

function allergy(
  format: SourceRow["format"],
  system: string,
  code: string,
  display: string,
): SourceRow {
  return {
    id: id(),
    resourceType: "AllergyIntolerance",
    format,
    duplicateOfId: null,
    codeSystem: system,
    code,
    resource: {
      clinicalStatus: { coding: [{ code: "active" }] },
      code: { coding: [{ system, code, display }] },
      recordedDate: "2019-01-01T00:00:00Z",
    },
  };
}

const flagCodes = (r: Reconciliation) =>
  distinctFlags(r.items)
    .map((f) => f.code)
    .sort();
const cited = (r: Reconciliation) => new Set([...r.current, ...r.incoming].map((x) => x.id));

describe("current chart as of the cutoff", () => {
  it("drops rows asserted after the cutoff and re-opens conditions that abated after it", () => {
    const later = condition("FHIR_BUNDLE", "10509002", "Acute bronchitis (disorder)", {
      onset: "2025-06-01T00:00:00Z",
    });
    const abatedLater = condition("FHIR_BUNDLE", "40055000", "Chronic sinusitis (disorder)", {
      status: "resolved",
      abated: "2025-02-01T00:00:00Z",
    });
    const rows = currentAsOf(
      [later, abatedLater].map((r) => toReconRow(r, "current")),
      CUTOFF,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: abatedLater.id,
      status: "active",
      end: null,
      asOfCutoff: true,
    });
  });

  it("defaults the cutoff to twelve months before the last encounter", () => {
    expect(defaultCutoff(new Date("2026-10-03T07:47:29Z")).toISOString()).toBe(
      "2025-10-03T07:47:29.000Z",
    );
  });
});

describe("buildReconciliation", () => {
  it("pairs by dedupe link, then code and day; the rest is NEW or CURRENT_ONLY", () => {
    const cur = condition("FHIR_BUNDLE", "59621000", "Essential hypertension (disorder)");
    const linked = condition("CCDA", "59621000", "Essential hypertension (disorder)", {
      dupOf: cur.id,
    });
    const cur2 = condition("FHIR_BUNDLE", "55822004", "Hyperlipidemia (disorder)");
    const sameDay = condition("CCDA", "55822004", "Hyperlipidemia (disorder)");
    const onlyCurrent = condition("FHIR_BUNDLE", "271737000", "Anemia (disorder)");
    const onlyIncoming = condition("CCDA", "10509002", "Acute bronchitis (disorder)", {
      status: "resolved",
      onset: "2025-05-01T00:00:00Z",
      abated: "2025-05-20T00:00:00Z",
    });
    const r = buildReconciliation([cur, linked, cur2, sameDay, onlyCurrent, onlyIncoming], CUTOFF);
    const byIncoming = new Map(r.items.map((it) => [it.incoming?.id ?? it.current!.id, it]));
    expect(byIncoming.get(linked.id)).toMatchObject({
      match: "SAME",
      category: "PROBLEM",
      current: { id: cur.id },
    });
    expect(byIncoming.get(sameDay.id)).toMatchObject({ match: "SAME", current: { id: cur2.id } });
    expect(byIncoming.get(onlyCurrent.id)).toMatchObject({ match: "CURRENT_ONLY", incoming: null });
    expect(byIncoming.get(onlyIncoming.id)).toMatchObject({
      match: "NEW",
      category: "PMH",
      current: null,
    });
    expect(r.items.map((it) => it.ordinal)).toEqual(r.items.map((_, i) => i));
  });

  it("flags a status flip, date and dose differences, and detail only the incoming copy has", () => {
    const cur = condition("FHIR_BUNDLE", "233678006", "Childhood asthma (disorder)");
    const inc = condition("CCDA", "233678006", "Childhood asthma (disorder)", {
      status: "resolved",
      onset: "2020-04-01T10:00:00Z",
      abated: "2024-06-01T00:00:00Z",
      dupOf: cur.id,
    });
    const curMed = med("FHIR_BUNDLE", "314076", { dose: 1 });
    const incMed = med("CCDA", "314076", { dose: 2, dupOf: curMed.id });
    const curMed2 = med("FHIR_BUNDLE", "313782", { status: "completed" });
    const incMed2 = med("CCDA", "313782", { status: "completed", dose: 1, dupOf: curMed2.id });
    const r = buildReconciliation([cur, inc, curMed, incMed, curMed2, incMed2], CUTOFF);
    expect(flagCodes(r)).toEqual([
      "adds_detail",
      "date_conflict",
      "dose_change",
      "status_conflict",
    ]);
    expect(r.items.find((it) => it.current?.id === cur.id)).toMatchObject({
      match: "CHANGED",
      category: "PROBLEM",
    });
    for (const f of distinctFlags(r.items)) expect(f.sourceIds).toHaveLength(2);
  });

  it("flags an allergy against an active medication, by ingredient and by class", () => {
    const aspirinAllergy = allergy("FHIR_BUNDLE", SYSTEM.RXNORM, "1191", "Aspirin");
    const aspirin = med("CCDA", "1191");
    const penicillinAllergy = allergy(
      "CCDA",
      SYSTEM.SNOMED,
      "91936005",
      "Allergy to penicillin (finding)",
    );
    const amoxicillin = med("FHIR_BUNDLE", "562251");
    const stopped = med("FHIR_BUNDLE", "834061", { status: "stopped" });
    const r = buildReconciliation(
      [aspirinAllergy, aspirin, penicillinAllergy, amoxicillin, stopped],
      CUTOFF,
    );
    const conflicts = distinctFlags(r.items).filter((f) => f.code === "allergy_med_conflict");
    expect(conflicts.map((f) => f.sourceIds)).toEqual(
      expect.arrayContaining([
        [aspirinAllergy.id, aspirin.id],
        [penicillinAllergy.id, amoxicillin.id],
      ]),
    );
    expect(conflicts).toHaveLength(2); // the stopped penicillin V is not active
    expect(conflicts.every((f) => f.severity === "high")).toBe(true);
  });

  it("flags active medications that share a strength, an ingredient or a class", () => {
    const lis10 = med("FHIR_BUNDLE", "314076");
    const lis20 = med("CCDA", "314077");
    const percocet = med("FHIR_BUNDLE", "1049625");
    const norco = med("CCDA", "856987");
    const r = buildReconciliation([lis10, lis20, percocet, norco], CUTOFF);
    const flags = distinctFlags(r.items);
    expect(flags.find((f) => f.code === "dose_change")?.sourceIds).toEqual([lis10.id, lis20.id]);
    const dup = flags.find((f) => f.code === "therapeutic_duplication");
    expect(dup?.message).toContain("acetaminophen, opioid");
  });

  it("flags an unmatched incoming condition that the crosswalk maps to a current one", () => {
    const cur = condition("FHIR_BUNDLE", "59621000", "Essential hypertension (disorder)");
    const icd = condition("CCDA", "I10", "Essential (primary) hypertension", {
      system: SYSTEM.ICD10CM,
    });
    const r = buildReconciliation([cur, icd], CUTOFF);
    expect(distinctFlags(r.items)).toEqual([
      expect.objectContaining({ code: "possible_duplicate", sourceIds: [cur.id, icd.id] }),
    ]);
  });

  it("only ever cites rows that are in the reconciliation", () => {
    const rows = [
      condition("FHIR_BUNDLE", "59621000", "Essential hypertension (disorder)"),
      med("FHIR_BUNDLE", "314076"),
      med("CCDA", "314077"),
      allergy("CCDA", SYSTEM.RXNORM, "1191", "Aspirin"),
      med("CCDA", "1191"),
    ];
    const r = buildReconciliation(rows, CUTOFF);
    const known = cited(r);
    for (const f of distinctFlags(r.items))
      for (const s of f.sourceIds) expect(known.has(s)).toBe(true);
  });
});

describe("local drug table", () => {
  it("resolves products to ingredients and classes, and allergens by code or text", () => {
    expect(drugProfile(SYSTEM.RXNORM, "1049625")).toEqual({
      ingredients: ["acetaminophen", "oxycodone"],
      classes: ["opioid"],
    });
    expect(drugProfile(SYSTEM.RXNORM, "999999")).toBeNull();
    expect(allergenProfile(SYSTEM.SNOMED, "x", "Penicillin (substance)")).toEqual({
      ingredients: [],
      classes: ["penicillin"],
    });
    expect(allergenProfile(SYSTEM.SNOMED, "3718001", "Cow's milk (substance)")).toBeNull();
  });
});
