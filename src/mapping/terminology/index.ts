// Terminology lookups behind one interface, so a live source (RxNav, UMLS) can sit in front of the committed
// tables later. Phase 2 uses the local tables only: NLM hosts are blocked by the network policy.
import cvx from "@/mapping/terminology/cvx.json";
import loinc from "@/mapping/terminology/loinc.json";
import rxnorm from "@/mapping/terminology/rxnorm.json";
import snomed from "@/mapping/terminology/snomed.json";
import { formatProblem } from "@/mapping/terminology/format";
import { SNOMED_TO_ICD10CM, type IcdTarget } from "@/mapping/terminology/snomed-icd10cm";

export { formatProblem, normalizeCode } from "@/mapping/terminology/format";
export { ucumCode, UCUM_UNITS } from "@/mapping/terminology/units";
export type { IcdTarget } from "@/mapping/terminology/snomed-icd10cm";

export type CodeLookup =
  | { status: "known"; display: string }
  | { status: "unknown" } // well-formed, but not in the table: a human decides
  | { status: "malformed"; reason: string }
  | { status: "unsupported_system" };

export interface TerminologySource {
  /** `system` must already be normalized (see normalizeSystem). */
  lookup(system: string, code: string): CodeLookup;
  /** SNOMED CT -> ICD-10-CM: a target, null (no diagnosis code applies), or undefined (not in the crosswalk). */
  icd10cm(snomedCode: string): IcdTarget | undefined;
}

type Table = { system: string; codes: Record<string, string> };
const TABLES = new Map<string, Record<string, string>>(
  ([snomed, loinc, rxnorm, cvx] as Table[]).map((t) => [t.system, t.codes]),
);

export function tableTerminology(
  tables: Map<string, Record<string, string>>,
  crosswalk: Record<string, IcdTarget>,
): TerminologySource {
  return {
    lookup(system, code) {
      const codes = tables.get(system);
      if (!codes) return { status: "unsupported_system" };
      const reason = formatProblem(system, code);
      if (reason) return { status: "malformed", reason };
      return Object.hasOwn(codes, code)
        ? { status: "known", display: codes[code]! }
        : { status: "unknown" };
    },
    icd10cm: (code) => (Object.hasOwn(crosswalk, code) ? crosswalk[code] : undefined),
  };
}

export const localTerminology: TerminologySource = tableTerminology(TABLES, SNOMED_TO_ICD10CM);
