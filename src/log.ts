// Application log (Phase 6). One JSON line per event: an event name from code plus fields from a fixed allowlist of
// non-identifying scalars (error class, status, counts, route template, request id). Anything else is dropped, never
// printed, so patient data cannot reach the log through a field. In production the server's console goes through
// the same filter (instrumentation.ts), because framework and database errors can echo values from a query.

type Level = "info" | "warn" | "error";
type Value = string | number | boolean | null | undefined;

const ALLOWED = new Set([
  "requestId",
  "route",
  "status",
  "errorClass",
  "digest",
  "code",
  "count",
  "ms",
  "retryAfter",
]);
// Codes, class names and uuids fit; free text does not. A route is a method plus a path template, or a rule name.
const SAFE_STRING = /^[A-Za-z0-9_.:/[\]-]{1,80}$/;
const ROUTE = /^((GET|POST) )?[A-Za-z0-9_./[\]-]{1,80}$/;

const out = {
  write: (line: string, level: Level) =>
    (level === "info" ? console.info : console.error).call(console, line),
};

/** Tests capture the log here. Returns a function that restores the previous sink. */
export function setLogSink(sink: (line: string, level: Level) => void): () => void {
  const prev = out.write;
  out.write = sink;
  return () => {
    out.write = prev;
  };
}

export function log(level: Level, event: string, fields: Record<string, Value> = {}): void {
  const line: Record<string, Value> = { t: new Date().toISOString(), level, event };
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const safe = typeof v !== "string" || (k === "route" ? ROUTE : SAFE_STRING).test(v);
    if (ALLOWED.has(k) && safe) line[k] = v;
    else dropped++;
  }
  if (dropped) line.dropped = dropped;
  out.write(JSON.stringify(line), level);
}

export const errorClass = (e: unknown) =>
  e instanceof Error ? e.constructor.name || e.name : typeof e;

/**
 * Replaces console.log/info/warn/error/debug with the filter: each call becomes one `console` event carrying the
 * class (and Next.js digest) of the first Error argument. Message text and other arguments are not printed.
 */
export function redactConsole(target: Console = console): void {
  const write = {
    info: target.info.bind(target),
    error: target.error.bind(target),
  };
  out.write = (line, level) => (level === "info" ? write.info : write.error)(line);
  for (const method of ["log", "info", "debug", "warn", "error"] as const) {
    const level: Level = method === "warn" ? "warn" : method === "error" ? "error" : "info";
    target[method] = (...args: unknown[]) => {
      const err = args.find((a): a is Error => a instanceof Error);
      const digest =
        err && "digest" in err && typeof err.digest === "string" ? err.digest : undefined;
      log(level, `console.${method}`, { errorClass: err ? errorClass(err) : undefined, digest });
    };
  }
}
