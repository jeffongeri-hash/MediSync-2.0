// Condition mentions in free text, for the "no hallucinated conditions" check. A concept mentioned in a claim must be
// supported by the display (or reaction) text of a cited row. Two sources of concepts:
//  1. every disorder, finding and situation in the local SNOMED CT table, by its display without the semantic tag;
//  2. a hand-written lexicon of common conditions with synonyms, so a condition no fixture has is still caught.
// Lexical and deliberately strict: the prompt forbids naming a condition that is not in the records at all.
import snomed from "@/mapping/terminology/snomed.json";

export interface ConditionConcept {
  key: string;
  /** Patterns that count as mentioning the concept in a claim. */
  mention: RegExp[];
  /** Patterns a cited row's text must match to support the mention (defaults to `mention`). */
  support: RegExp[];
}

const words = (...terms: string[]) =>
  terms.map((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));

function concept(key: string, mention: string[], support?: string[]): ConditionConcept {
  return { key, mention: words(...mention), support: words(...(support ?? mention)) };
}

/** Common conditions and their synonyms. Support patterns are broader than mentions on purpose. */
const LEXICON: ConditionConcept[] = [
  concept(
    "diabetes",
    ["diabetes", "diabetes mellitus", "diabetic", "t2dm", "t1dm", "dm2"],
    ["diabetes", "diabetic"],
  ),
  concept("prediabetes", ["prediabetes", "prediabetic", "impaired fasting glucose"]),
  concept(
    "hypertension",
    ["hypertension", "hypertensive", "high blood pressure", "htn"],
    ["hypertension", "hypertensive"],
  ),
  concept(
    "hyperlipidemia",
    ["hyperlipidemia", "dyslipidemia", "hypercholesterolemia", "high cholesterol"],
    ["hyperlipidemia", "dyslipidemia", "hypercholesterolemia", "cholesterol"],
  ),
  concept("asthma", ["asthma", "asthmatic"], ["asthma"]),
  concept("copd", [
    "copd",
    "chronic obstructive pulmonary disease",
    "emphysema",
    "chronic bronchitis",
  ]),
  concept(
    "heart failure",
    ["heart failure", "cardiac failure", "chf"],
    ["heart failure", "cardiac failure"],
  ),
  concept("coronary artery disease", [
    "coronary artery disease",
    "coronary heart disease",
    "ischemic heart disease",
    "angina",
  ]),
  concept("myocardial infarction", ["myocardial infarction", "heart attack"]),
  concept("atrial fibrillation", ["atrial fibrillation", "afib", "a-fib"], ["atrial fibrillation"]),
  concept("stroke", ["stroke", "cerebrovascular accident", "transient ischemic attack"]),
  concept(
    "kidney disease",
    [
      "chronic kidney disease",
      "kidney disease",
      "ckd",
      "renal failure",
      "kidney failure",
      "renal insufficiency",
      "nephropathy",
    ],
    ["kidney", "renal", "nephropathy"],
  ),
  concept(
    "depression",
    ["depression", "depressive disorder", "major depressive"],
    ["depression", "depressive"],
  ),
  concept("anxiety", ["anxiety", "anxiety disorder"], ["anxiety"]),
  concept("obesity", ["obesity", "obese"], ["obesity", "obese"]),
  concept("hypothyroidism", ["hypothyroidism", "underactive thyroid"]),
  concept("hyperthyroidism", ["hyperthyroidism", "overactive thyroid"]),
  concept("osteoarthritis", ["osteoarthritis", "degenerative joint disease"]),
  concept("rheumatoid arthritis", ["rheumatoid arthritis"]),
  concept("osteoporosis", ["osteoporosis"]),
  concept("reflux", ["gastroesophageal reflux", "gerd", "acid reflux"], ["reflux"]),
  concept(
    "cancer",
    [
      "cancer",
      "carcinoma",
      "malignancy",
      "malignant",
      "neoplasm",
      "tumor",
      "lymphoma",
      "leukemia",
      "metastatic",
    ],
    ["cancer", "carcinoma", "malignancy", "malignant", "neoplasm", "tumor", "lymphoma", "leukemia"],
  ),
  concept("anemia", ["anemia", "anaemia", "anemic"], ["anemia", "anaemia"]),
  concept("sleep apnea", ["sleep apnea", "sleep apnoea"], ["apnea", "apnoea"]),
  concept("migraine", ["migraine", "migraines"], ["migraine"]),
  concept("epilepsy", ["epilepsy", "seizure disorder", "seizures"]),
  concept("dementia", ["dementia", "alzheimer", "alzheimer's"]),
  concept("cirrhosis", ["cirrhosis"]),
  concept("hepatitis", ["hepatitis"]),
  concept("hiv", ["hiv"]),
  concept("pneumonia", ["pneumonia"]),
  concept("sinusitis", ["sinusitis"]),
  concept("bronchitis", ["bronchitis"]),
  concept("allergic rhinitis", ["allergic rhinitis", "hay fever"], ["rhinitis"]),
  concept("dermatitis", ["dermatitis", "eczema"], ["dermatitis", "eczema"]),
  concept("back pain", ["back pain"]),
  concept("neck pain", ["neck pain"]),
  concept(
    "alcohol use",
    ["alcohol use disorder", "alcoholism", "alcohol abuse", "alcohol dependence"],
    ["alcohol"],
  ),
  concept("pregnancy", ["pregnancy", "pregnant"], ["pregnancy", "pregnant", "miscarriage"]),
];

const CONDITION_TAG = /\s*\((disorder|finding|situation)\)\s*$/;
const SNOMED_CONCEPTS: ConditionConcept[] = Object.values(
  (snomed as { codes: Record<string, string> }).codes,
)
  .filter((d) => CONDITION_TAG.test(d))
  .map((d) => d.replace(CONDITION_TAG, "").trim())
  .filter((d) => d.length >= 4)
  .map((d) => concept(d.toLowerCase(), [d]));

export const CONDITION_CONCEPTS: ConditionConcept[] = [...LEXICON, ...SNOMED_CONCEPTS];

/** "pre-diabetes" is prediabetes, not a mention of diabetes. */
const normalize = (text: string) => text.replace(/\bpre-(?=diabet)/gi, "pre");

export function conditionMentions(text: string, concepts = CONDITION_CONCEPTS): ConditionConcept[] {
  const t = normalize(text);
  return concepts.filter((c) => c.mention.some((re) => re.test(t)));
}

export function supports(concept: ConditionConcept, rowText: string): boolean {
  const t = normalize(rowText);
  return concept.support.some((re) => re.test(t));
}
