// One summary request end to end: alias the reconciliation, prompt, ask the responder, validate every claim.
import { prepareInput, type PreparedInput } from "@/ai/input";
import { PROMPT_VERSION, SYSTEM_PROMPT, inputHash, userMessage } from "@/ai/prompt";
import type { AiRequest, AiResponse, Responder } from "@/ai/responders";
import { checkOutput, type CheckedOutput } from "@/ai/validate";
import type { Reconciliation } from "@/reconcile/build";

export interface SummaryResult {
  prepared: PreparedInput;
  request: AiRequest;
  response: AiResponse;
  checked: CheckedOutput;
}

export function summaryRequest(prepared: PreparedInput, caseId?: string): AiRequest {
  const user = userMessage(prepared.input);
  return {
    caseId,
    system: SYSTEM_PROMPT,
    user,
    promptVersion: PROMPT_VERSION,
    inputSha256: inputHash(SYSTEM_PROMPT, user),
    input: prepared.input,
  };
}

export async function summarize(
  recon: Reconciliation,
  responder: Responder,
  caseId?: string,
): Promise<SummaryResult> {
  const prepared = prepareInput(recon);
  const request = summaryRequest(prepared, caseId);
  const response = await responder.respond(request);
  const checked =
    response.error && response.raw === null
      ? { error: response.error, claims: [] }
      : checkOutput(response.raw, prepared);
  return {
    prepared,
    request,
    response,
    checked: { ...checked, error: response.error ?? checked.error },
  };
}
