import { afterEach, describe, expect, it } from "vitest";
import { guarded } from "@/http";
import { log, redactConsole, setLogSink } from "@/log";

let restore: (() => void) | null = null;
const capture = () => {
  const lines: string[] = [];
  restore = setLogSink((line) => lines.push(line));
  return lines;
};
afterEach(() => restore?.());

describe("application log", () => {
  it("keeps allowlisted scalar fields and drops everything else", () => {
    const lines = capture();
    log("error", "test_event", {
      route: "GET /api/transfer/[id]",
      status: 500,
      errorClass: "PrismaClientKnownRequestError",
      requestId: "9b2f6a1e-7d4c-4b0a-9f00-000000000001",
      name: "Jesús618 Gutiérrez",
      route2: "x",
      code: "Corie618 Smith",
    });
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      event: "test_event",
      route: "GET /api/transfer/[id]",
      status: 500,
      errorClass: "PrismaClientKnownRequestError",
      dropped: 3,
    });
    expect(lines[0]).not.toMatch(/Jes|Corie|Smith/);
  });

  it("reduces console calls to the class and digest of the error", () => {
    const written: string[] = [];
    const fake = {
      log: () => {},
      info: (s: string) => written.push(s),
      debug: () => {},
      warn: () => {},
      error: (s: string) => written.push(s),
    } as unknown as Console;
    redactConsole(fake);
    restore = setLogSink((line) => written.push(line));
    const err = Object.assign(new TypeError("Patient Jesús618 born 1961-03-02"), {
      digest: "123456",
    });
    fake.error("Failed for Jesús618:", err, { birthDate: "1961-03-02" });
    fake.log("plain text with Corie618");
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!)).toMatchObject({
      event: "console.error",
      errorClass: "TypeError",
      digest: "123456",
    });
    expect(written.join("\n")).not.toMatch(/Jes|Corie|1961/);
  });

  it("turns an uncaught route error into a 500 with a request id, logging only its class", async () => {
    const lines = capture();
    const handler = guarded("GET /x", async () => {
      throw new RangeError("value Jesús618 out of range");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal error");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "route_error",
      route: "GET /x",
      errorClass: "RangeError",
      requestId: body.requestId,
    });
    expect(lines.join("\n")).not.toContain("Jes");
  });
});
