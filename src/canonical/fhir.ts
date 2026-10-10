import { z } from "zod";

// FHIR R4 (4.0.1) primitives. Regexes follow the spec's datatype definitions.
export const fhirId = z.string().regex(/^[A-Za-z0-9\-.]{1,64}$/, "invalid FHIR id");
const code = z.string().regex(/^[^\s]+( [^\s]+)*$/, "invalid FHIR code");
const uri = z.string().regex(/^\S+$/, "invalid FHIR uri");
const YEAR = String.raw`([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)`;
const TZ = String.raw`(Z|(\+|-)((0[0-9]|1[0-3]):[0-5][0-9]|14:00))`;
const TIME = String.raw`([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?`;
const MD = String.raw`(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1]))?)?`;
export const fhirDate = z.string().regex(new RegExp(`^${YEAR}${MD}$`), "invalid FHIR date");
export const fhirDateTime = z
  .string()
  .regex(
    new RegExp(`^${YEAR}(-(0[1-9]|1[0-2])(-(0[1-9]|[1-2][0-9]|3[0-1])(T${TIME}${TZ})?)?)?$`),
    "invalid FHIR dateTime",
  );
const instant = z
  .string()
  .regex(
    new RegExp(`^${YEAR}-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T${TIME}${TZ}$`),
    "invalid FHIR instant",
  );

// Complex datatypes. Loose objects: canonical keeps every field the source sent.
export const coding = z.looseObject({
  system: uri.optional(),
  code: code.optional(),
  display: z.string().optional(),
});
export const codeableConcept = z.looseObject({
  coding: z.array(coding).optional(),
  text: z.string().optional(),
});
export const reference = z.looseObject({
  reference: z.string().optional(),
  display: z.string().optional(),
});
const period = z.looseObject({ start: fhirDateTime.optional(), end: fhirDateTime.optional() });
const quantity = z.looseObject({
  value: z.number().optional(),
  unit: z.string().optional(),
  system: uri.optional(),
  code: code.optional(),
});
const attachment = z.looseObject({
  contentType: code.optional(),
  data: z.string().optional(),
  url: z.string().optional(),
});

/** At most one `prefix[x]` choice element (e.g. valueQuantity vs valueString); exactly one when required. */
function choice(prefix: string, required = false) {
  return (r: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const keys = Object.keys(r).filter(
      (k) => k.startsWith(prefix) && /^[A-Z]/.test(k.slice(prefix.length)),
    );
    if (keys.length > 1 || (required && keys.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: [`${prefix}[x]`],
        message: required ? "exactly one required" : "at most one allowed",
      });
    }
  };
}

const base = <T extends string>(type: T) => ({
  resourceType: z.literal(type),
  id: fhirId,
  meta: z.looseObject({}).optional(),
});

const patient = z.looseObject({
  ...base("Patient"),
  gender: z.enum(["male", "female", "other", "unknown"]).optional(),
  birthDate: fhirDate.optional(),
  name: z
    .array(z.looseObject({ family: z.string().optional(), given: z.array(z.string()).optional() }))
    .optional(),
});

const condition = z
  .looseObject({
    ...base("Condition"),
    clinicalStatus: codeableConcept.optional(),
    verificationStatus: codeableConcept.optional(),
    category: z.array(codeableConcept).optional(),
    code: codeableConcept.optional(),
    subject: reference,
    onsetDateTime: fhirDateTime.optional(),
    abatementDateTime: fhirDateTime.optional(),
    recordedDate: fhirDateTime.optional(),
  })
  .superRefine(choice("onset"))
  .superRefine(choice("abatement"));

/** Has no patient field: ingest attributes it through the MedicationRequest/Statement that references it. */
const medication = z.looseObject({
  ...base("Medication"),
  code: codeableConcept.optional(),
  status: z.enum(["active", "inactive", "entered-in-error"]).optional(),
});

const medicationRequest = z
  .looseObject({
    ...base("MedicationRequest"),
    status: z.enum([
      "active",
      "on-hold",
      "cancelled",
      "completed",
      "entered-in-error",
      "stopped",
      "draft",
      "unknown",
    ]),
    intent: z.enum([
      "proposal",
      "plan",
      "order",
      "original-order",
      "reflex-order",
      "filler-order",
      "instance-order",
      "option",
    ]),
    medicationCodeableConcept: codeableConcept.optional(),
    medicationReference: reference.optional(),
    subject: reference,
    authoredOn: fhirDateTime.optional(),
  })
  .superRefine(choice("medication", true));

const medicationStatement = z
  .looseObject({
    ...base("MedicationStatement"),
    status: z.enum([
      "active",
      "completed",
      "entered-in-error",
      "intended",
      "stopped",
      "on-hold",
      "unknown",
      "not-taken",
    ]),
    medicationCodeableConcept: codeableConcept.optional(),
    medicationReference: reference.optional(),
    subject: reference,
    effectiveDateTime: fhirDateTime.optional(),
    effectivePeriod: period.optional(),
  })
  .superRefine(choice("medication", true))
  .superRefine(choice("effective"));

const allergyIntolerance = z
  .looseObject({
    ...base("AllergyIntolerance"),
    clinicalStatus: codeableConcept.optional(),
    verificationStatus: codeableConcept.optional(),
    type: z.enum(["allergy", "intolerance"]).optional(),
    category: z.array(z.enum(["food", "medication", "environment", "biologic"])).optional(),
    criticality: z.enum(["low", "high", "unable-to-assess"]).optional(),
    code: codeableConcept.optional(),
    patient: reference,
    onsetDateTime: fhirDateTime.optional(),
    recordedDate: fhirDateTime.optional(),
    reaction: z
      .array(
        z.looseObject({
          substance: codeableConcept.optional(),
          manifestation: z.array(codeableConcept).min(1),
          severity: z.enum(["mild", "moderate", "severe"]).optional(),
        }),
      )
      .optional(),
  })
  .superRefine(choice("onset"));

const observation = z
  .looseObject({
    ...base("Observation"),
    status: z.enum([
      "registered",
      "preliminary",
      "final",
      "amended",
      "corrected",
      "cancelled",
      "entered-in-error",
      "unknown",
    ]),
    category: z.array(codeableConcept).optional(),
    code: codeableConcept,
    subject: reference.optional(),
    effectiveDateTime: fhirDateTime.optional(),
    effectivePeriod: period.optional(),
    issued: instant.optional(),
    valueQuantity: quantity.optional(),
    valueCodeableConcept: codeableConcept.optional(),
    valueString: z.string().optional(),
    valueInteger: z.number().int().optional(),
    component: z
      .array(z.looseObject({ code: codeableConcept }).superRefine(choice("value")))
      .optional(),
  })
  .superRefine(choice("effective"))
  .superRefine(choice("value"));

const immunization = z
  .looseObject({
    ...base("Immunization"),
    status: z.enum(["completed", "entered-in-error", "not-done"]),
    vaccineCode: codeableConcept,
    patient: reference,
    occurrenceDateTime: fhirDateTime.optional(),
    occurrenceString: z.string().optional(),
  })
  .superRefine(choice("occurrence", true));

const procedure = z
  .looseObject({
    ...base("Procedure"),
    status: z.enum([
      "preparation",
      "in-progress",
      "not-done",
      "on-hold",
      "stopped",
      "completed",
      "entered-in-error",
      "unknown",
    ]),
    code: codeableConcept.optional(),
    subject: reference,
    performedDateTime: fhirDateTime.optional(),
    performedPeriod: period.optional(),
  })
  .superRefine(choice("performed"));

const encounter = z.looseObject({
  ...base("Encounter"),
  status: z.enum([
    "planned",
    "arrived",
    "triaged",
    "in-progress",
    "onleave",
    "finished",
    "cancelled",
    "entered-in-error",
    "unknown",
  ]),
  class: coding,
  type: z.array(codeableConcept).optional(),
  subject: reference.optional(),
  period: period.optional(),
});

const documentReference = z.looseObject({
  ...base("DocumentReference"),
  status: z.enum(["current", "superseded", "entered-in-error"]),
  type: codeableConcept.optional(),
  subject: reference.optional(),
  date: instant.optional(),
  content: z.array(z.looseObject({ attachment })).min(1),
});

/** The canonical resource scope (BUILD_PLAN Phase 1, plus Medication in Phase 2). Everything else is kept raw and reported. */
export const canonicalSchemas = {
  Patient: patient,
  Condition: condition,
  Medication: medication,
  MedicationRequest: medicationRequest,
  MedicationStatement: medicationStatement,
  AllergyIntolerance: allergyIntolerance,
  Observation: observation,
  Immunization: immunization,
  Procedure: procedure,
  Encounter: encounter,
  DocumentReference: documentReference,
} as const;

export type CanonicalType = keyof typeof canonicalSchemas;
export const CANONICAL_TYPES = Object.keys(canonicalSchemas) as CanonicalType[];
export type CanonicalResource = z.infer<(typeof canonicalSchemas)[CanonicalType]>;

export function isCanonicalType(t: string): t is CanonicalType {
  return Object.hasOwn(canonicalSchemas, t);
}

/** Where each type points at its patient, used to attribute resources from multi-patient sources (NDJSON). */
export const PATIENT_FIELD: Record<
  Exclude<CanonicalType, "Patient" | "Medication">,
  "subject" | "patient"
> = {
  Condition: "subject",
  MedicationRequest: "subject",
  MedicationStatement: "subject",
  AllergyIntolerance: "patient",
  Observation: "subject",
  Immunization: "patient",
  Procedure: "subject",
  Encounter: "subject",
  DocumentReference: "subject",
};

/** The element holding each type's primary clinical code; a missing or text-only code goes to review. */
export const PRIMARY_CODE: Partial<Record<CanonicalType, string>> = {
  Condition: "code",
  Medication: "code",
  MedicationRequest: "medicationCodeableConcept",
  MedicationStatement: "medicationCodeableConcept",
  AllergyIntolerance: "code",
  Observation: "code",
  Immunization: "vaccineCode",
  Procedure: "code",
  DocumentReference: "type",
};
