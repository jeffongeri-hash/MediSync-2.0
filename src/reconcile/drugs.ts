// Local drug knowledge for the reconcile rules: RxNorm product -> ingredients, ingredient -> class, allergen terms.
// Hand-written for the fixtures' own RxNorm codes (src/mapping/terminology/rxnorm.json). UNVERIFIED: NLM hosts are
// blocked, and the class labels are a coarse local grouping, not a drug-interaction or allergy cross-reactivity source.
import { SYSTEM } from "@/mapping/systems";

/** RxNorm code (product or ingredient) -> ingredient names, lower case, salt dropped. */
export const RXNORM_INGREDIENTS: Record<string, string[]> = {
  "1191": ["aspirin"],
  "106258": ["hydrocortisone"],
  "106892": ["insulin isophane", "insulin regular"],
  "200033": ["carvedilol"],
  "308136": ["amlodipine"],
  "310798": ["hydrochlorothiazide"],
  "310965": ["ibuprofen"],
  "312617": ["prednisone"],
  "313782": ["acetaminophen"],
  "313988": ["furosemide"],
  "314076": ["lisinopril"],
  "314077": ["lisinopril"],
  "314231": ["simvastatin"],
  "351109": ["budesonide"],
  "562251": ["amoxicillin", "clavulanate"],
  "630208": ["albuterol"],
  "834061": ["penicillin v"],
  "835603": ["tramadol"],
  "856987": ["acetaminophen", "hydrocodone"],
  "857005": ["acetaminophen", "hydrocodone"],
  "979492": ["losartan"],
  "997488": ["fexofenadine"],
  "997501": ["fexofenadine"],
  "1043400": ["acetaminophen", "dextromethorphan", "doxylamine"],
  "1049504": ["oxycodone"],
  "1049625": ["acetaminophen", "oxycodone"],
  "1049630": ["diphenhydramine"],
  "1535362": ["sodium fluoride"],
  "1860491": ["hydrocodone"],
  "1870230": ["epinephrine"],
};

/** Ingredient -> local class labels. Route matters for steroids, so those classes name it. */
export const INGREDIENT_CLASSES: Record<string, string[]> = {
  aspirin: ["salicylate"],
  hydrocortisone: ["topical corticosteroid"],
  "insulin isophane": ["insulin"],
  "insulin regular": ["insulin"],
  carvedilol: ["beta blocker"],
  amlodipine: ["calcium channel blocker"],
  hydrochlorothiazide: ["thiazide diuretic"],
  ibuprofen: ["nsaid"],
  prednisone: ["systemic corticosteroid"],
  furosemide: ["loop diuretic"],
  lisinopril: ["ace inhibitor"],
  enalapril: ["ace inhibitor"],
  simvastatin: ["statin"],
  atorvastatin: ["statin"],
  budesonide: ["inhaled corticosteroid"],
  amoxicillin: ["penicillin"],
  "penicillin v": ["penicillin"],
  albuterol: ["short-acting beta agonist"],
  tramadol: ["opioid"],
  hydrocodone: ["opioid"],
  oxycodone: ["opioid"],
  losartan: ["angiotensin receptor blocker"],
  fexofenadine: ["antihistamine"],
  doxylamine: ["antihistamine"],
  diphenhydramine: ["antihistamine"],
};

/** Allergen words (allergy code display or text) -> what they cover: ingredients, or a whole class. */
const ALLERGEN_TERMS: Record<string, { ingredients?: string[]; classes?: string[] }> = {
  aspirin: { ingredients: ["aspirin"] },
  penicillin: { classes: ["penicillin"] },
  penicillins: { classes: ["penicillin"] },
  "penicillin v": { ingredients: ["penicillin v"] },
  amoxicillin: { ingredients: ["amoxicillin"] },
  ibuprofen: { ingredients: ["ibuprofen"] },
  nsaid: { classes: ["nsaid"] },
  opioid: { classes: ["opioid"] },
  codeine: { ingredients: ["codeine"] },
  lisinopril: { ingredients: ["lisinopril"] },
  "ace inhibitor": { classes: ["ace inhibitor"] },
  sulfonamide: { classes: ["sulfonamide"] },
};

export type DrugProfile = { ingredients: string[]; classes: string[] };

const classesOf = (ingredients: string[]) => [
  ...new Set(ingredients.flatMap((i) => INGREDIENT_CLASSES[i] ?? [])),
];

/** Ingredients and classes of a medication coding; null when the code is not in the local table. */
export function drugProfile(system: string | null, code: string | null): DrugProfile | null {
  if (system !== SYSTEM.RXNORM || !code) return null;
  const ingredients = RXNORM_INGREDIENTS[code];
  return ingredients ? { ingredients, classes: classesOf(ingredients) } : null;
}

const normalizeTerm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // SNOMED semantic tag, e.g. "(substance)"
    .replace(/\b(allergy|allergic|to|substance|product|containing)\b/g, " ")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** What a drug allergy covers, from its RxNorm code or its display text; null for non-drug allergens. */
export function allergenProfile(
  system: string | null,
  code: string | null,
  display: string,
): { ingredients: string[]; classes: string[] } | null {
  const byCode = drugProfile(system, code);
  // An allergy coded to a single-ingredient product or an ingredient covers the ingredient, not its class.
  if (byCode) return { ingredients: byCode.ingredients, classes: [] };
  const term = ALLERGEN_TERMS[normalizeTerm(display)];
  return term ? { ingredients: term.ingredients ?? [], classes: term.classes ?? [] } : null;
}
