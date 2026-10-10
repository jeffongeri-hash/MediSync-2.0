import { createHash } from "node:crypto";
import { issue, type IngestIssue } from "@/canonical";
import { cd, entryId, timeOf, ts, valueOf, type Ctx } from "@/ingest/ccda/datatypes";
import { at, attr, hasTemplate, kid, kids, parseXml, templates, text, type XNode } from "@/ingest/ccda/xml";

/** A FHIR-shaped object built from C-CDA, before canonical validation. */
export type Draft = { resource: Record<string, unknown>; path: string };

const T = (n: string) => `2.16.840.1.113883.10.20.22.4.${n}`;
const OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const SNOMED_SEVERITY: Record<string, string> = { "255604002": "mild", "6736007": "moderate", "24484000": "severe" };
const ALLERGY_KIND: Record<string, { type?: string; category?: string }> = {
  "419199007": { type: "allergy" },
  "414285001": { type: "allergy", category: "food" },
  "416098002": { type: "allergy", category: "medication" },
  "426232007": { type: "allergy", category: "environment" },
  "418471000": { category: "food" },
  "419511003": { category: "medication" },
  "235719002": { type: "intolerance", category: "food" },
  "59037007": { type: "intolerance", category: "medication" },
};
const statusCode = (n: XNode | undefined) => attr(kid(n, "statusCode"), "code");
const concept = (system: string, code: string) => ({ coding: [{ system, code }] });

type Mapper = (el: XNode, path: string, ctx: Ctx, subject: { reference: string }) => Draft[];

function begin(ctx: Ctx, resourceType: string, el: XNode, path: string): string {
  const id = entryId(el, ctx, path);
  ctx.resourceType = resourceType;
  ctx.fhirId = id;
  return id;
}

function observation(category: string): Mapper {
  return (el, path, ctx, subject) => {
    const id = begin(ctx, "Observation", el, path);
    const t = timeOf(kid(el, "effectiveTime"), ctx, `${path}/effectiveTime`);
    const sc = statusCode(el);
    const status = sc === "completed" ? "final" : sc === "active" ? "preliminary" : sc === "aborted" ? "cancelled" : "unknown";
    const resource = {
      resourceType: "Observation",
      id,
      status,
      category: [{ coding: [{ system: OBS_CATEGORY, code: category }] }],
      code: cd(kid(el, "code"), ctx, `${path}/code`) ?? {},
      subject,
      ...(t.point ? { effectiveDateTime: t.point } : t.start || t.end ? { effectivePeriod: { start: t.start, end: t.end } } : {}),
      ...valueOf(kid(el, "value"), ctx, `${path}/value`),
    };
    return [{ resource, path }];
  };
}

/** Result / vital-signs organizers: one Observation per component; the organizer (a DiagnosticReport) is not kept. */
function organizer(member: string, category: string): Mapper {
  const obs = observation(category);
  return (el, path, ctx, subject) => {
    ctx.issues.push(
      issue("INFO", "unsupported_resource", "C-CDA organizer (DiagnosticReport-like) not converted; member observations kept", {
        path,
        resourceType: "DiagnosticReport",
      }),
    );
    return kids(el, "component").flatMap((c, i) => {
      const o = kid(c, "observation");
      const p = `${path}/component[${i + 1}]/observation`;
      if (o && hasTemplate(o, member)) return obs(o, p, ctx, subject);
      ctx.issues.push(issue("WARNING", "unmapped_section", "Organizer component with unexpected template not converted", { path: p }));
      return [];
    });
  };
}

const problem: Mapper = (act, path, ctx, subject) =>
  kids(act, "entryRelationship").flatMap((er, i) => {
    const obs = kid(er, "observation");
    if (!obs || !hasTemplate(obs, T("4"))) return [];
    const p = `${path}/entryRelationship[${i + 1}]/observation`;
    const id = begin(ctx, "Condition", act, path);
    const t = timeOf(kid(obs, "effectiveTime"), ctx, `${p}/effectiveTime`);
    const sc = statusCode(act);
    const clinical = sc === "active" ? "active" : sc === "completed" || t.end ? "resolved" : undefined;
    const resource = {
      resourceType: "Condition",
      id,
      ...(clinical ? { clinicalStatus: concept("http://terminology.hl7.org/CodeSystem/condition-clinical", clinical) } : {}),
      category: [concept("http://terminology.hl7.org/CodeSystem/condition-category", "problem-list-item")],
      code: cd(kid(obs, "value"), ctx, `${p}/value`),
      subject,
      ...(t.start ?? t.point ? { onsetDateTime: t.start ?? t.point } : {}),
      ...(t.end ? { abatementDateTime: t.end } : {}),
    };
    return [{ resource, path }];
  });

const allergy: Mapper = (act, path, ctx, patient) =>
  kids(act, "entryRelationship").flatMap((er, i) => {
    const obs = kid(er, "observation");
    if (!obs || !hasTemplate(obs, T("7"))) return [];
    const p = `${path}/entryRelationship[${i + 1}]/observation`;
    const id = begin(ctx, "AllergyIntolerance", act, path);
    const t = timeOf(kid(obs, "effectiveTime"), ctx, `${p}/effectiveTime`);
    const sc = statusCode(act);
    const clinical = sc === "active" ? "active" : sc === "completed" ? "resolved" : sc === "suspended" ? "inactive" : undefined;
    const kind = ALLERGY_KIND[attr(kid(obs, "value"), "code") ?? ""] ?? {};
    const related = kids(obs, "entryRelationship").map((r) => kid(r, "observation"));
    const severityObs = related.find((o) => hasTemplate(o, T("8")) || attr(kid(o, "code"), "code") === "SEV");
    const severity = SNOMED_SEVERITY[attr(kid(severityObs, "value"), "code") ?? ""];
    const manifestations = related
      .filter((o) => hasTemplate(o, T("9")))
      .flatMap((o) => cd(kid(o, "value"), ctx, `${p}/entryRelationship/observation/value`) ?? []);
    const resource = {
      resourceType: "AllergyIntolerance",
      id,
      ...(clinical ? { clinicalStatus: concept("http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", clinical) } : {}),
      ...(kind.type ? { type: kind.type } : {}),
      ...(kind.category ? { category: [kind.category] } : {}),
      code: cd(at(obs, "participant", "participantRole", "playingEntity", "code"), ctx, `${p}/participant`),
      patient,
      ...(t.start ?? t.point ? { onsetDateTime: t.start ?? t.point } : {}),
      ...(manifestations.length ? { reaction: [{ manifestation: manifestations, ...(severity ? { severity } : {}) }] } : {}),
    };
    return [{ resource, path }];
  });

/** Medication activity: moodCode EVN is a statement of use, INT an order. */
const medication: Mapper = (el, path, ctx, subject) => {
  const isOrder = attr(el, "moodCode") === "INT";
  const id = begin(ctx, isOrder ? "MedicationRequest" : "MedicationStatement", el, path);
  const t = timeOf(kids(el, "effectiveTime")[0], ctx, `${path}/effectiveTime`);
  const sc = statusCode(el);
  const status =
    sc === "active" ? "active" : sc === "completed" ? "completed" : sc === "aborted" ? "stopped" : sc === "suspended" ? "on-hold" : "unknown";
  const med = cd(at(el, "consumable", "manufacturedProduct", "manufacturedMaterial", "code"), ctx, `${path}/consumable`);
  const dose = Number(attr(kid(el, "doseQuantity"), "value"));
  const unit = attr(kid(el, "doseQuantity"), "unit");
  const dosage = Number.isFinite(dose) ? [{ doseAndRate: [{ doseQuantity: { value: dose, ...(unit ? { unit } : {}) } }] }] : undefined;
  const resource = isOrder
    ? { resourceType: "MedicationRequest", id, status, intent: "order", medicationCodeableConcept: med ?? {}, subject, ...(t.start ? { authoredOn: t.start } : {}), ...(dosage ? { dosageInstruction: dosage } : {}) }
    : {
        resourceType: "MedicationStatement",
        id,
        status,
        medicationCodeableConcept: med ?? {},
        subject,
        ...(t.point ? { effectiveDateTime: t.point } : t.start || t.end ? { effectivePeriod: { start: t.start, end: t.end } } : {}),
        ...(dosage ? { dosage } : {}),
      };
  return [{ resource, path }];
};

const immunization: Mapper = (el, path, ctx, patient) => {
  const id = begin(ctx, "Immunization", el, path);
  const sc = statusCode(el);
  const status = attr(el, "negationInd") === "true" ? "not-done" : sc === "completed" ? "completed" : sc === "nullified" ? "entered-in-error" : undefined;
  if (!status) {
    ctx.issues.push(issue("WARNING", "invalid_value", "Immunization statusCode has no FHIR equivalent; entry not converted", { path, resourceType: "Immunization", fhirId: id }));
    return [];
  }
  const t = timeOf(kid(el, "effectiveTime"), ctx, `${path}/effectiveTime`);
  const resource = {
    resourceType: "Immunization",
    id,
    status,
    vaccineCode: cd(at(el, "consumable", "manufacturedProduct", "manufacturedMaterial", "code"), ctx, `${path}/consumable`) ?? {},
    patient,
    ...(t.point ?? t.start ? { occurrenceDateTime: t.point ?? t.start } : {}),
  };
  return [{ resource, path }];
};

const procedure: Mapper = (el, path, ctx, subject) => {
  const id = begin(ctx, "Procedure", el, path);
  const sc = statusCode(el);
  const status =
    sc === "completed" ? "completed" : sc === "active" ? "in-progress" : sc === "aborted" ? "stopped" : sc === "cancelled" ? "not-done" : "unknown";
  const t = timeOf(kid(el, "effectiveTime"), ctx, `${path}/effectiveTime`);
  const resource = {
    resourceType: "Procedure",
    id,
    status,
    code: cd(kid(el, "code"), ctx, `${path}/code`),
    subject,
    ...(t.point ? { performedDateTime: t.point } : t.start || t.end ? { performedPeriod: { start: t.start, end: t.end } } : {}),
  };
  return [{ resource, path }];
};

/** C-CDA encounters carry no class and often no status; both are FHIR-required, so they are defaulted and reported. */
const encounter: Mapper = (el, path, ctx, subject) => {
  const id = begin(ctx, "Encounter", el, path);
  const t = timeOf(kid(el, "effectiveTime"), ctx, `${path}/effectiveTime`);
  const start = t.start ?? t.point;
  const type = cd(kid(el, "code"), ctx, `${path}/code`);
  ctx.issues.push(
    issue("INFO", "defaulted_field", "Encounter.class absent in C-CDA; set to v3-NullFlavor UNK", { path, resourceType: "Encounter" }),
  );
  const resource = {
    resourceType: "Encounter",
    id,
    status: t.end ? "finished" : "unknown",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-NullFlavor", code: "UNK" },
    ...(type ? { type: [type] } : {}),
    subject,
    ...(start || t.end ? { period: { start, end: t.end } } : {}),
  };
  return [{ resource, path }];
};

/** Entry templates we convert, keyed by templateId root. */
const MAPPERS: Record<string, Mapper> = {
  [T("30")]: allergy,
  [T("3")]: problem,
  [T("16")]: medication,
  [T("1")]: organizer(T("2"), "laboratory"),
  [T("26")]: organizer(T("27"), "vital-signs"),
  [T("14")]: procedure,
  [T("49")]: encounter,
  [T("52")]: immunization,
  [T("78")]: observation("social-history"),
  [T("38")]: observation("social-history"),
  [T("69")]: observation("survey"),
};
const ENTRY_ELEMENTS = ["act", "observation", "organizer", "substanceAdministration", "procedure", "encounter", "supply"];

function patientOf(doc: XNode, ctx: Ctx): Draft | null {
  const role = at(doc, "recordTarget", "patientRole");
  const p = at(role, "patient");
  const path = "/ClinicalDocument/recordTarget/patientRole";
  if (!role || !p) return null;
  const idEl = kids(role, "id").find((i) => attr(i, "extension")) ?? kid(role, "id");
  const ext = attr(idEl, "extension");
  const id = ext && /^[A-Za-z0-9\-.]{1,64}$/.test(ext) ? ext : entryId(role, ctx, path);
  ctx.resourceType = "Patient";
  ctx.fhirId = id;
  const name = kids(p, "name").map((n) => ({
    ...(text(kid(n, "family")) ? { family: text(kid(n, "family")) } : {}),
    given: kids(n, "given").flatMap((g) => text(g) ?? []),
  }));
  const g = attr(kid(p, "administrativeGenderCode"), "code");
  const gender = g === "F" ? "female" : g === "M" ? "male" : g === "UN" ? "other" : "unknown";
  const birth = ts(attr(kid(p, "birthTime"), "value"), ctx, `${path}/patient/birthTime`)?.slice(0, 10);
  const address = kids(role, "addr")
    .filter((a) => !attr(a, "nullFlavor"))
    .map((a) => ({
      line: kids(a, "streetAddressLine").flatMap((l) => text(l) ?? []),
      city: text(kid(a, "city")),
      state: text(kid(a, "state")),
      postalCode: text(kid(a, "postalCode")),
    }));
  const omb = (url: string, el: XNode | undefined) => {
    const code = attr(el, "code");
    if (!code) return [];
    const display = attr(el, "displayName");
    return [
      {
        url: `http://hl7.org/fhir/us/core/StructureDefinition/${url}`,
        extension: [
          { url: "ombCategory", valueCoding: { system: "urn:oid:2.16.840.1.113883.6.238", code, ...(display ? { display } : {}) } },
          { url: "text", valueString: display ?? code },
        ],
      },
    ];
  };
  const extension = [...omb("us-core-race", kid(p, "raceCode")), ...omb("us-core-ethnicity", kid(p, "ethnicGroupCode"))];
  const resource = {
    resourceType: "Patient",
    id,
    ...(extension.length ? { extension } : {}),
    identifier: ext ? [{ system: attr(idEl, "assigningAuthorityName") ?? `urn:oid:${attr(idEl, "root")}`, value: ext }] : undefined,
    name,
    gender,
    ...(birth ? { birthDate: birth } : {}),
    ...(address.length ? { address } : {}),
  };
  return { resource, path };
}

export type CcdaDrafts = { drafts: Draft[]; issues: IngestIssue[]; patientId: string | null };

/** C-CDA R2.1 document -> FHIR-shaped drafts (not yet validated). Unknown sections/templates are reported, never dropped silently. */
export function ccdaToDrafts(rawText: string): CcdaDrafts {
  const ctx: Ctx = { issues: [], docKey: createHash("sha256").update(rawText).digest("hex") };
  const root = parseXml(rawText);
  const doc = kid(root ?? undefined, "ClinicalDocument");
  if (!doc) {
    return { drafts: [], issues: [issue("ERROR", "parse_error", "Not a well-formed C-CDA ClinicalDocument")], patientId: null };
  }
  const patient = patientOf(doc, ctx);
  if (!patient) {
    return { drafts: [], issues: [issue("ERROR", "parse_error", "C-CDA has no recordTarget/patientRole/patient")], patientId: null };
  }
  const patientId = patient.resource.id as string;
  const subject = { reference: `Patient/${patientId}` };
  const drafts: Draft[] = [patient];

  kids(at(doc, "component", "structuredBody"), "component").forEach((comp, ci) => {
    const section = kid(comp, "section");
    const sPath = `/ClinicalDocument/component/structuredBody/component[${ci + 1}]/section`;
    const sectionTemplate = templates(section)[0] ?? "(none)";
    kids(section, "entry").forEach((entry, ei) => {
      const name = ENTRY_ELEMENTS.find((e) => kid(entry, e));
      const el = name ? kid(entry, name) : undefined;
      const path = `${sPath}/entry[${ei + 1}]/${name ?? "*"}`;
      const mapper = templates(el).map((t) => MAPPERS[t]).find(Boolean);
      if (!el || !mapper) {
        ctx.issues.push(
          issue("WARNING", "unmapped_section", `C-CDA entry (section ${sectionTemplate}, template ${templates(el)[0] ?? "none"}) not converted`, { path }),
        );
        return;
      }
      drafts.push(...mapper(el, path, ctx, subject));
    });
  });
  return { drafts, issues: ctx.issues, patientId };
}
