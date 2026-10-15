// Route handler errors (Phase 6): an uncaught error becomes 500 {error, requestId} and one log line carrying the
// route template, request id and error class only, never the message (it can echo query values).
import { randomUUID } from "node:crypto";
import { errorClass, log } from "@/log";

const isNextControlFlow = (e: unknown) =>
  e instanceof Error &&
  "digest" in e &&
  typeof e.digest === "string" &&
  e.digest.startsWith("NEXT_");

export function guarded<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (isNextControlFlow(e)) throw e;
      const requestId = randomUUID();
      log("error", "route_error", { route, requestId, errorClass: errorClass(e) });
      return Response.json(
        { error: "internal error", requestId },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
