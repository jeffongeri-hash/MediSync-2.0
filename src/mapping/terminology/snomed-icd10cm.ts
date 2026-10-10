// SNOMED CT -> ICD-10-CM for Condition.code, covering the problem list in the Synthea fixtures.
// UNVERIFIED: written from memory, not from the NLM SNOMED CT to ICD-10-CM map (NLM hosts are blocked; see
// docs/NOTES.md). A value of `null` means the concept is a social or administrative fact with no diagnosis code
// to give (INFO in the review queue). A concept missing from this table goes to the review queue as unmapped.

export type IcdTarget = { code: string; display: string } | null;

export const SNOMED_TO_ICD10CM: Record<string, IcdTarget> = {
  // Disorders
  "241929008": { code: "T78.40XA", display: "Allergy, unspecified, initial encounter" },
  "10509002": { code: "J20.9", display: "Acute bronchitis, unspecified" },
  "271737000": { code: "D64.9", display: "Anemia, unspecified" },
  "162864005": { code: "E66.9", display: "Obesity, unspecified" },
  "233678006": { code: "J45.909", display: "Unspecified asthma, uncomplicated" },
  "88805009": { code: "I50.9", display: "Heart failure, unspecified" },
  "431855005": { code: "N18.1", display: "Chronic kidney disease, stage 1" },
  "278860009": { code: "M54.50", display: "Low back pain, unspecified" },
  "1121000119107": { code: "M54.2", display: "Cervicalgia" },
  "82423001": { code: "G89.29", display: "Other chronic pain" },
  "40055000": { code: "J32.9", display: "Chronic sinusitis, unspecified" },
  "40275004": { code: "L25.9", display: "Unspecified contact dermatitis, unspecified cause" },
  "127013003": {
    code: "E11.29",
    display: "Type 2 diabetes mellitus with other diabetic kidney complication",
  },
  "59621000": { code: "I10", display: "Essential (primary) hypertension" },
  "18718003": {
    code: "K06.9",
    display: "Disorder of gingiva and edentulous alveolar ridge, unspecified",
  },
  "66383009": { code: "K05.10", display: "Chronic gingivitis, plaque induced" },
  "55822004": { code: "E78.5", display: "Hyperlipidemia, unspecified" },
  "90460009": { code: "S19.9XXA", display: "Unspecified injury of neck, initial encounter" },
  "237602007": { code: "E88.81", display: "Metabolic syndrome" },
  "78275009": { code: "G47.33", display: "Obstructive sleep apnea (adult) (pediatric)" },
  "68496003": { code: "K63.5", display: "Polyp of colon" },
  "714628002": { code: "R73.03", display: "Prediabetes" },
  "109570002": { code: "K02.9", display: "Dental caries, unspecified" },
  "367498001": { code: "J30.2", display: "Other seasonal allergic rhinitis" },
  "39898005": { code: "G47.9", display: "Sleep disorder, unspecified" },
  "43878008": { code: "J02.0", display: "Streptococcal pharyngitis" },
  "427419006": {
    code: "G43.709",
    display: "Chronic migraine without aura, not intractable, without status migrainosus",
  },
  "444814009": { code: "J01.90", display: "Acute sinusitis, unspecified" },
  "39848009": {
    code: "S13.4XXA",
    display: "Sprain of ligaments of cervical spine, initial encounter",
  },
  // History / status
  "428251008": {
    code: "Z90.49",
    display: "Acquired absence of other specified parts of digestive tract",
  },
  "267020005": { code: "Z98.51", display: "Tubal ligation status" },
  "161744009": {
    code: "Z87.59",
    display: "Personal history of other complications of pregnancy, childbirth and the puerperium",
  },
  // Social determinants with a Z code
  "73595000": { code: "Z73.3", display: "Stress, not elsewhere classified" },
  "73438004": { code: "Z56.0", display: "Unemployment, unspecified" },
  "105531004": { code: "Z59.10", display: "Inadequate housing, unspecified" },
  "713458007": { code: "Z59.82", display: "Transportation insecurity" },
  "266934004": { code: "Z59.82", display: "Transportation insecurity" },
  // Social or administrative facts that are not a diagnosis
  "314529007": null, // Medication review due (situation)
  "160903007": null, // Full-time employment (finding)
  "160904001": null, // Part-time employment (finding)
  "741062008": null, // Not in labor force (finding)
  "473461003": null, // Educated to high school level (finding)
  "224299000": null, // Received higher education (finding)
};
