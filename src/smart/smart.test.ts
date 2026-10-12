import { describe, expect, it } from "vitest";
import { parseFhirBundle } from "@/ingest/parse-fhir";
import { renderWritebackReport, summarizeCapability, supports } from "@/smart/capability";
import {
  launchScope,
  serverByName,
  serverForIss,
  serverLabel,
  smartConfig,
  SmartConfigError,
  smartServers,
  sourceSystemFor,
} from "@/smart/config";
import { seal, sessionIdOf, unseal } from "@/smart/crypto";
import {
  assembleBundle,
  missingMedications,
  onServer,
  readPatientRecord,
  RecordReadError,
  type FhirGet,
} from "@/smart/fetch";

const ISS = "https://ehr.example.test/fhir/R4";
const SECRET = Buffer.alloc(32, 1).toString("base64");
const env = {
  SMART_CLIENT_ID: "c",
  SMART_ISS: `${ISS}/, http://127.0.0.1:4010/fhir`,
  SMART_REDIRECT_URI: "http://localhost:3000/smart/callback",
  SESSION_SECRET: SECRET,
};
const ORACLE_ISS = "https://fhir-ehr-code.cerner.com/r4/tenant-id";
const named = {
  SMART_SERVERS: "epic, oracle",
  SMART_EPIC_ISS: "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4",
  SMART_EPIC_CLIENT_ID: "epic-client",
  SMART_ORACLE_ISS: `${ORACLE_ISS}/`,
  SMART_ORACLE_CLIENT_ID: "oracle-client",
  SMART_ORACLE_SCOPE: "patient/Patient.rs patient/Condition.rs",
  SMART_REDIRECT_URI: "http://localhost:3000/smart/callback",
  SESSION_SECRET: SECRET,
};

describe("smartConfig", () => {
  it("single-server form: an iss list sharing one client id, default read scopes, the session key", () => {
    const cfg = smartConfig(env);
    expect(cfg.servers.map((s) => [s.name, s.iss, s.clientId])).toEqual([
      ["default", ISS, "c"],
      ["default-2", "http://127.0.0.1:4010/fhir", "c"],
    ]);
    expect(cfg.servers[0]!.readScopes.split(" ")).toContain("patient/AllergyIntolerance.read");
    expect(cfg.servers[0]!.readScopes).not.toContain("*");
    expect(cfg.sessionKey).toHaveLength(32);
    expect(
      smartConfig({ ...env, SMART_SCOPE: " patient/Patient.rs  patient/Condition.rs " }).servers[0]!
        .readScopes,
    ).toBe("patient/Patient.rs patient/Condition.rs");
  });

  it("named form: one registration per EHR, each with its own client id and optional scopes", () => {
    const cfg = smartConfig({
      ...named,
      SMART_CLIENT_ID: "ignored",
      SMART_ISS: "https://ignored.test",
    });
    expect(cfg.servers.map((s) => [s.name, s.iss, s.clientId])).toEqual([
      ["epic", named.SMART_EPIC_ISS, "epic-client"],
      ["oracle", ORACLE_ISS, "oracle-client"],
    ]);
    expect(serverByName(cfg, "Oracle")?.readScopes).toBe("patient/Patient.rs patient/Condition.rs");
    expect(serverByName(cfg, "epic")?.readScopes).toContain("patient/Condition.read");
    expect(serverByName(cfg, "cerner")).toBeNull();
    // Scripts read the servers without the session secret.
    expect(smartServers({ ...named, SESSION_SECRET: "" })).toHaveLength(2);
  });

  it("names missing or weak settings without echoing values", () => {
    expect(() => smartConfig({})).toThrow(SmartConfigError);
    expect(() => smartConfig({ ...env, SMART_CLIENT_ID: "" })).toThrow(/SMART_CLIENT_ID/);
    expect(() =>
      smartConfig({ ...env, SESSION_SECRET: Buffer.alloc(8).toString("base64") }),
    ).toThrow(/SESSION_SECRET/);
    expect(() => smartConfig({ ...env, SMART_ISS: "ftp://secret-host" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-host") }),
    );
    expect(() => smartConfig({ ...named, SMART_ORACLE_CLIENT_ID: "" })).toThrow(
      /SMART_ORACLE_CLIENT_ID/,
    );
    expect(() => smartConfig({ ...named, SMART_SERVERS: "epic,epic" })).toThrow(/SMART_SERVERS/);
    expect(() => smartConfig({ ...named, SMART_SERVERS: "Epic Sandbox" })).toThrow(/SMART_SERVERS/);
    expect(() => smartConfig({ ...named, SMART_ORACLE_ISS: named.SMART_EPIC_ISS })).toThrow(
      /distinct ISS/,
    );
  });

  it("matches only an exact configured iss, and builds scopes per launch kind", () => {
    const cfg = smartConfig(named);
    expect(serverForIss(cfg, `${ORACLE_ISS}/`)?.name).toBe("oracle");
    expect(serverForIss(cfg, `${ORACLE_ISS}/../other`)).toBeNull();
    expect(serverForIss(cfg, `${ORACLE_ISS}x`)).toBeNull();
    expect(serverForIss(cfg, null)).toBeNull();
    expect(launchScope("ehr", "patient/Patient.read")).toBe(
      "launch openid fhirUser patient/Patient.read",
    );
    expect(launchScope("standalone", "patient/Patient.read")).toBe(
      "launch/patient openid fhirUser patient/Patient.read",
    );
    expect(sourceSystemFor(named.SMART_EPIC_ISS)).toBe("epic-sandbox");
    expect(sourceSystemFor(ORACLE_ISS)).toBe("oracle-sandbox");
    expect(sourceSystemFor(ISS)).toBe("smart:ehr.example.test");
    expect(sourceSystemFor("http://127.0.0.1:4010/fhir")).toBe("smart:127.0.0.1:4010");
    expect(serverLabel(ORACLE_ISS)).toBe("Oracle Health sandbox");
    expect(serverLabel("http://127.0.0.1:4010/fhir")).toBe("127.0.0.1:4010");
  });
});

describe("sealed session state", () => {
  const key = Buffer.alloc(32, 9);
  it("round-trips, and fails on another session id, another key or tampering", () => {
    const id = sessionIdOf("token");
    const sealed = seal({ tokenResponse: { access_token: "abc" } }, key, id);
    expect(sealed).not.toContain("abc");
    expect(unseal(sealed, key, id)).toEqual({ tokenResponse: { access_token: "abc" } });
    expect(() => unseal(sealed, key, sessionIdOf("other"))).toThrow();
    expect(() => unseal(sealed, Buffer.alloc(32, 8), id)).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from(
      "x" + Buffer.from(parts[3]!, "base64url").toString("latin1"),
      "latin1",
    ).toString("base64url");
    expect(() => unseal(parts.join("."), key, id)).toThrow();
  });
});

describe("readPatientRecord", () => {
  const patient = { resourceType: "Patient", id: "p1" };
  const cond = (id: string, ref = "Patient/p1") => ({
    resourceType: "Condition",
    id,
    subject: { reference: ref },
    code: { text: "x" },
  });
  const searchset = (entries: object[], next?: string) => ({
    resourceType: "Bundle",
    type: "searchset",
    entry: entries,
    link: next ? [{ relation: "next", url: next }] : [],
  });
  const server =
    (pages: Record<string, unknown>, calls: string[] = []): FhirGet =>
    async (url) => {
      calls.push(url);
      const key = Object.keys(pages).find(
        (k) => url === k || url.startsWith(`${k}&`) || url === `${ISS}/${k}`,
      );
      if (!key)
        return searchset([
          { resource: { resourceType: "OperationOutcome", id: "w" }, search: { mode: "outcome" } },
        ]);
      const v = pages[key];
      if (v instanceof Error) throw v;
      return v;
    };

  it("follows next links on the server, skips outcome entries, reads missing Medications, and is deterministic", async () => {
    const calls: string[] = [];
    const pages = {
      "Patient/p1": patient,
      "Condition?patient=p1&category=encounter-diagnosis": searchset(
        [{ resource: cond("c2", `${ISS}/Patient/p1`) }],
        `${ISS}/Condition?page=2`,
      ),
      [`${ISS}/Condition?page=2`]: searchset([{ resource: cond("c1") }]),
      "MedicationRequest?patient=p1": searchset([
        {
          resource: {
            resourceType: "MedicationRequest",
            id: "m1",
            subject: { reference: "Patient/p1" },
            medicationReference: { reference: `${ISS}/Medication/med1` },
          },
        },
      ]),
      "Medication/med1": { resourceType: "Medication", id: "med1" },
    };
    const r = await readPatientRecord(server(pages, calls), ISS, "p1");
    expect(r.queries.find((q) => q.label === "Condition:encounter-diagnosis")).toMatchObject({
      ok: true,
      count: 2,
      pages: 2,
    });
    expect(r.queries.find((q) => q.label === "Condition:problem-list-item")).toMatchObject({
      ok: true,
      count: 0,
      outcomes: 1,
    });
    expect(r.queries.find((q) => q.label === "Medication")).toMatchObject({ ok: true, count: 1 });
    expect(r.bundle.entry.map((e) => e.fullUrl)).toEqual(
      ["Condition/c1", "Condition/c2", "Medication/med1", "MedicationRequest/m1", "Patient/p1"].map(
        (k) => `${ISS}/${k}`,
      ),
    );
    expect(calls).toContain("Medication/med1");

    // Ingest resolves the server's absolute references against the fullUrls, so rows attribute to the patient.
    const parsed = parseFhirBundle(r.bytes.toString("utf8"));
    expect(parsed.resources.find((x) => x.resource.id === "c2")?.sourcePatientId).toBe("p1");

    const again = await readPatientRecord(server(pages), ISS, "p1");
    expect(again.bytes.equals(r.bytes)).toBe(true);
  });

  it("never follows a next link off the FHIR server, and reports HTTP errors per query", async () => {
    const calls: string[] = [];
    const r = await readPatientRecord(
      server(
        {
          "Patient/p1": patient,
          "Condition?patient=p1&category=problem-list-item": searchset(
            [{ resource: cond("c1") }],
            "https://elsewhere.test/fhir/Condition?page=2",
          ),
          "AllergyIntolerance?patient=p1": Object.assign(new Error("Forbidden"), { status: 403 }),
        },
        calls,
      ),
      ISS,
      "p1",
    );
    expect(r.queries.find((q) => q.label === "Condition:problem-list-item")).toMatchObject({
      ok: false,
      error: "next_link_off_server",
      count: 1,
    });
    expect(r.queries.find((q) => q.label === "AllergyIntolerance")).toMatchObject({
      ok: false,
      error: "http_403",
    });
    expect(calls.some((c) => c.includes("elsewhere"))).toBe(false);
  });

  it("fails as a whole when the Patient read fails or returns another patient", async () => {
    await expect(
      readPatientRecord(
        server({ "Patient/p1": Object.assign(new Error("x"), { status: 404 }) }),
        ISS,
        "p1",
      ),
    ).rejects.toBeInstanceOf(RecordReadError);
    await expect(
      readPatientRecord(server({ "Patient/p1": { resourceType: "Patient", id: "p2" } }), ISS, "p1"),
    ).rejects.toMatchObject({ code: "patient_read_failed" });
  });

  it("helpers: onServer, missingMedications, assembleBundle", () => {
    expect(onServer(`${ISS}/Condition?page=2`, ISS)).toBe(true);
    expect(onServer("Condition?page=2", ISS)).toBe(true);
    expect(onServer("https://ehr.example.test/fhir/R4-other/Condition", ISS)).toBe(false);
    expect(onServer("https://ehr.example.test.evil/fhir/R4/Condition", ISS)).toBe(false);
    const mr = (ref: string) => ({
      resourceType: "MedicationRequest",
      id: ref,
      medicationReference: { reference: ref },
    });
    expect(
      missingMedications(
        [
          mr("Medication/a"),
          mr("#contained"),
          mr("Medication/../x"),
          mr("Medication/.."),
          mr(`${ISS}/Medication/b`),
          { resourceType: "Medication", id: "a" },
        ],
        ISS,
      ),
    ).toEqual(["b"]);
    expect(
      assembleBundle([cond("z"), cond("a"), cond("a", "Patient/other")], ISS).entry.map(
        (e) => e.resource.subject,
      ),
    ).toEqual([{ reference: "Patient/p1" }, { reference: "Patient/p1" }]);
  });
});

describe("CapabilityStatement summary and write-back report", () => {
  const cs = {
    resourceType: "CapabilityStatement",
    fhirVersion: "4.0.1",
    software: { name: "Example EHR", version: "1" },
    rest: [
      {
        mode: "server",
        resource: [
          { type: "Patient", interaction: [{ code: "read" }, { code: "search-type" }] },
          {
            type: "AllergyIntolerance",
            interaction: [{ code: "read" }, { code: "create" }, { code: "create" }],
          },
          { type: "DocumentReference", interaction: [{ code: "create" }] },
        ],
      },
    ],
  };

  it("lists interactions per type and renders the write-back paths", () => {
    const s = summarizeCapability(cs, ISS);
    expect(s.resources.map((r) => r.type)).toEqual([
      "AllergyIntolerance",
      "DocumentReference",
      "Patient",
    ]);
    expect(s.resources[0]!.interactions).toEqual(["create", "read"]);
    expect(supports(s, "AllergyIntolerance", "create")).toBe(true);
    expect(supports(s, "Condition", "create")).toBe(false);
    expect(supports(null, "Patient", "read")).toBe(false);
    const md = renderWritebackReport(s, new Date("2026-10-12T00:00:00Z"));
    expect(md).toContain(`Server (iss): ${ISS}`);
    expect(md).toContain("| AllergyIntolerance | yes | - | yes | - | - | - |");
    expect(md).toContain("FHIR writes for reconciled items: AllergyIntolerance.");
    expect(md).toContain(
      "Document submission (C-CDA or PDF via DocumentReference/Binary): DocumentReference.",
    );
  });

  it("rejects anything that is not a CapabilityStatement", () => {
    expect(() => summarizeCapability({ resourceType: "Patient" }, ISS)).toThrow(
      /CapabilityStatement/,
    );
  });
});
