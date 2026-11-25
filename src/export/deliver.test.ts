import { describe, expect, it } from "vitest";
import { postTransaction, transferTargets, TransferTargetError } from "@/export/deliver";

const target = { name: "ehrb", label: "EHR B", url: "http://127.0.0.1:4020/fhir" };
const bundle = JSON.stringify({
  resourceType: "Bundle",
  type: "transaction",
  entry: [
    {
      fullUrl: "urn:uuid:1",
      resource: { resourceType: "Patient" },
      request: { method: "POST", url: "Patient" },
    },
    {
      fullUrl: "urn:uuid:2",
      resource: { resourceType: "Condition" },
      request: { method: "POST", url: "Condition" },
    },
  ],
});
const answer = (status: number, body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/fhir+json" },
    })) as unknown as typeof fetch;
const created = (...locations: string[]) => ({
  resourceType: "Bundle",
  type: "transaction-response",
  entry: locations.map((location) => ({ response: { status: "201 Created", location } })),
});

describe("transfer targets", () => {
  it("reads named loopback targets and defaults the label to the name", () => {
    expect(
      transferTargets({
        TRANSFER_TARGETS: "ehrb, ehr-c",
        TRANSFER_EHRB_URL: "http://127.0.0.1:4020/fhir/",
        TRANSFER_EHRB_LABEL: "EHR B (mock)",
        TRANSFER_EHR_C_URL: "http://localhost:4030/fhir",
      }),
    ).toEqual([
      { name: "ehrb", label: "EHR B (mock)", url: "http://127.0.0.1:4020/fhir" },
      { name: "ehr-c", label: "ehr-c", url: "http://localhost:4030/fhir" },
    ]);
    expect(transferTargets({})).toEqual([]);
  });

  it("refuses a remote target, so nothing is ever sent to a real EHR", () => {
    expect(() =>
      transferTargets({
        TRANSFER_TARGETS: "epic",
        TRANSFER_EPIC_URL: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
      }),
    ).toThrow(/not a loopback test server/);
  });

  it("names the missing variable, never a value", () => {
    expect(() => transferTargets({ TRANSFER_TARGETS: "ehrb" })).toThrow(TransferTargetError);
    expect(() => transferTargets({ TRANSFER_TARGETS: "ehrb" })).toThrow(/TRANSFER_EHRB_URL/);
    expect(() => transferTargets({ TRANSFER_TARGETS: "Bad Name" })).toThrow(/invalid name/);
  });
});

describe("postTransaction", () => {
  it("counts what the target created and keeps the Patient id it assigned", async () => {
    const d = await postTransaction(target, bundle, {
      fetchFn: answer(200, created("Patient/rx-1/_history/1", "Condition/rx-2/_history/1")),
    });
    expect(d).toEqual({
      httpStatus: 200,
      created: { Patient: 1, Condition: 1 },
      targetPatientId: "rx-1",
      error: null,
    });
  });

  it("reports an HTTP failure with OperationOutcome codes only, not diagnostics", async () => {
    const d = await postTransaction(target, bundle, {
      fetchFn: answer(422, {
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "invalid", diagnostics: "Smith, John: bad birthDate" }],
      }),
    });
    expect(d.error).toBe("ehrb answered HTTP 422 (invalid)");
    expect(d.error).not.toContain("Smith");
  });

  it("fails when the target did not create every entry", async () => {
    expect(
      (await postTransaction(target, bundle, { fetchFn: answer(200, created("Patient/rx-1")) }))
        .error,
    ).toBe("ehrb answered 1 entries for 2 sent");
    expect(
      (await postTransaction(target, bundle, { fetchFn: answer(200, { resourceType: "Bundle" }) }))
        .error,
    ).toMatch(/transaction-response/);
  });

  it("reports an unreachable target without throwing", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const d = await postTransaction(target, bundle, { fetchFn: down });
    expect(d).toMatchObject({ httpStatus: null, error: "could not reach ehrb (TypeError)" });
  });
});
