// Offline code-format checks. Check digits catch typos and truncation that a table lookup alone cannot tell
// apart from "a real code we have not seen yet".
import { SYSTEM } from "@/mapping/systems";

// Verhoeff dihedral-group tables (SNOMED CT identifiers end in a Verhoeff check digit).
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => (c = D[c]![P[i % 8]![Number(ch)]!]!));
  return c === 0;
}

/** LOINC "nnnnn-c": c is a mod-10 (Luhn) check digit over the number. */
export function loincCheckValid(code: string): boolean {
  const [num, check] = code.split("-");
  let sum = 0;
  [...num!].reverse().forEach((ch, i) => {
    const n = Number(ch) * (i % 2 === 0 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return (10 - (sum % 10)) % 10 === Number(check);
}

/** Trims every code; ICD-10-CM is upper-cased and gets its dot back (claims data often drops it: E119 -> E11.9). */
export function normalizeCode(system: string, code: string): string {
  const c = code.trim();
  if (system !== SYSTEM.ICD10CM) return c;
  const u = c.toUpperCase();
  return /^[A-Z]\d[0-9A-Z][0-9A-Z]{1,4}$/.test(u) ? `${u.slice(0, 3)}.${u.slice(3)}` : u;
}

/** Why a code cannot belong to its system, or null when it is well-formed. Unknown systems are not checked. */
export function formatProblem(system: string, code: string): string | null {
  switch (system) {
    case SYSTEM.SNOMED:
      if (!/^[1-9]\d{5,17}$/.test(code)) return "SNOMED CT id must be 6-18 digits";
      // Partition identifier (2nd and 3rd digits from the right): 00/10 = concept; others are descriptions etc.
      if (!["00", "10"].includes(code.slice(-3, -1))) return "SNOMED CT id is not a concept id";
      return verhoeffValid(code) ? null : "SNOMED CT check digit is wrong";
    case SYSTEM.LOINC:
      if (/^L[AP]\d+-\d$/.test(code)) return null; // answer and part codes
      if (!/^\d{1,5}-\d$/.test(code)) return "LOINC code must look like nnnnn-c";
      return loincCheckValid(code) ? null : "LOINC check digit is wrong";
    case SYSTEM.RXNORM:
      return /^[1-9]\d{0,9}$/.test(code) ? null : "RxNorm RXCUI must be numeric";
    case SYSTEM.CVX:
      return /^\d{1,3}$/.test(code) ? null : "CVX code must be 1-3 digits";
    case SYSTEM.ICD10CM:
      return /^[A-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/.test(code)
        ? null
        : "ICD-10-CM code must look like A00.0000";
    default:
      return null;
  }
}
