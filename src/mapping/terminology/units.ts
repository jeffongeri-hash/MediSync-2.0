// UCUM units seen in the fixtures plus common US non-UCUM spellings. Values are never rescaled in Phase 2:
// normalization only makes the unit machine-readable (system + code); conversion belongs where values are compared.

export const UCUM_UNITS: Record<string, string> = {
  "%": "percent",
  "/min": "per minute",
  "/a": "per year",
  "10*3/uL": "thousand per microliter",
  "10*6/uL": "million per microliter",
  Cel: "degree Celsius",
  "[degF]": "degree Fahrenheit",
  "U/L": "unit per liter",
  cm: "centimeter",
  mm: "millimeter",
  "[in_i]": "inch",
  fL: "femtoliter",
  pg: "picogram",
  "g/L": "gram per liter",
  "g/dL": "gram per deciliter",
  kg: "kilogram",
  g: "gram",
  "[lb_av]": "pound",
  "kg/m2": "kilogram per square meter",
  "mL/min": "milliliter per minute",
  "mL/min/{1.73_m2}": "milliliter per minute per 1.73 square meters",
  "mg/dL": "milligram per deciliter",
  "mmol/L": "millimole per liter",
  "mm[Hg]": "millimeter of mercury",
  "ng/mL": "nanogram per milliliter",
  "pg/mL": "picogram per milliliter",
  "ug/L": "microgram per liter",
  "ug/dL": "microgram per deciliter",
  pH: "pH",
  "{score}": "score",
  "{nominal}": "nominal",
  "{#}": "count",
};

/** Non-UCUM spellings -> UCUM code. Keys are matched exactly after trimming. */
export const UNIT_ALIASES: Record<string, string> = {
  mmHg: "mm[Hg]",
  "beats/min": "/min",
  "breaths/min": "/min",
  bpm: "/min",
  C: "Cel",
  "°C": "Cel",
  degC: "Cel",
  F: "[degF]",
  "°F": "[degF]",
  "kg/m^2": "kg/m2",
  "kg/m²": "kg/m2",
  lb: "[lb_av]",
  lbs: "[lb_av]",
  in: "[in_i]",
  "mcg/dL": "ug/dL",
  "mcg/L": "ug/L",
  "K/uL": "10*3/uL",
  "M/uL": "10*6/uL",
  "mL/min/1.73m2": "mL/min/{1.73_m2}",
  score: "{score}",
};

/** UCUM code for a unit written as UCUM or a known alias; undefined when unknown. */
export function ucumCode(unit: string): string | undefined {
  const u = unit.trim();
  return Object.hasOwn(UCUM_UNITS, u) ? u : UNIT_ALIASES[u];
}
