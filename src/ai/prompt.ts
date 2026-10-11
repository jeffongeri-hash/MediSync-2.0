// Reconciliation summary prompt and output schema. Bump PROMPT_VERSION on any change to the text or the schema:
// recordings are replayed only for the same prompt version and input hash.
import { z } from "zod";
import { sha256, type AiInput } from "@/ai/input";

export const PROMPT_VERSION = "reconcile-summary@1";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const EFFORT = "high" as const;
export const MAX_TOKENS = 16000;

export const SUMMARY_TOPICS = ["active_problem", "past_history", "medication", "allergy"] as const;
export const AI_FLAG_TYPES = ["possible_duplicate", "conflict"] as const;

export const aiOutputSchema = z.object({
  summary: z.array(
    z.object({
      topic: z.enum(SUMMARY_TOPICS),
      text: z.string(),
      source_ids: z.array(z.string()),
    }),
  ),
  flags: z.array(
    z.object({
      type: z.enum(AI_FLAG_TYPES),
      text: z.string(),
      source_ids: z.array(z.string()),
    }),
  ),
});
export type AiOutput = z.infer<typeof aiOutputSchema>;

export const SYSTEM_PROMPT = `You help a clinician reconcile a patient's problem list, medications and allergies.

You receive two sets of records as JSON. CURRENT records (ids C1, C2, ...) are this clinic's chart as it stood on the cutoff date. INCOMING records (ids I1, I2, ...) arrived from an outside organization. Rows paired as the same fact carry "same_as". A current row marked "as_of_cutoff" is shown with the status it had on the cutoff date. Deterministic rules have already compared the records; their findings are in "rule_flags".

Return a JSON object with two lists.

"summary": a concise past medical history for the clinician, as separate one-sentence statements. Give each statement a topic: active_problem, past_history, medication or allergy. In "source_ids", cite every record the statement relies on, using the record ids from the input.

"flags": duplicates or conflicts between records that rule_flags do not already cover, such as the same condition recorded under a different code or different wording. Cite every record involved. Return an empty list when there are none.

Rules:
- Use only the records provided. Do not add diagnoses, medications, allergies, dates, causes or severity that no cited record states.
- Do not mention a condition that is not in the records, not even to say it is absent.
- Keep each record's own clinical wording. Do not generalize a condition into a different one (for example, prediabetes is not diabetes).
- Cite only record ids (C or I ids) that appear in the input. Never cite rule flag ids.
- Where the current and incoming records disagree, say so and cite both.
- Administrative or social entries (for example "Medication review due", employment or education findings) may be grouped into one past_history statement or left out.
- Do not give treatment advice.`;

export function userMessage(input: AiInput): string {
  return `Reconcile these records. Cutoff date: ${input.cutoff}.\n\n<records>\n${JSON.stringify(input)}\n</records>`;
}

/** Hash of exactly what the model is sent, so a recording replays only for identical input. */
export function inputHash(system: string, user: string): string {
  return sha256(`${system}\n\n${user}`);
}
