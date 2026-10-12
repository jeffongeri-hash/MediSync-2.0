// TEST-ONLY mock of a SMART on FHIR server: discovery, an auto-approving authorization endpoint (PKCE S256 enforced),
// a token endpoint, a simulated EHR launcher, and a read-only FHIR API over synthetic Synthea patients. It stands in
// for the Epic sandbox, which this build container cannot reach. Its CapabilityStatement is a fixture written for
// tests; it says nothing about what Epic supports.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Resource = { resourceType: string; id: string; [k: string]: unknown };

export const MOCK_TYPES = [
  "Patient",
  "Condition",
  "MedicationRequest",
  "Medication",
  "AllergyIntolerance",
  "Encounter",
];
export const MOCK_PRACTITIONER = "Practitioner/mock-practitioner-1";

export type MockSmartOptions = {
  port?: number;
  clientId: string;
  redirectUris: string[];
  /** Synthea patient bundle files (synthetic data only). The first patient is the standalone default. */
  bundles: string[];
  pageSize?: number;
  /** Searches on these types answer 500 (to test partial reads). */
  failTypes?: string[];
};

export type MockSmart = {
  base: string;
  iss: string;
  patientIds: string[];
  /** URL that simulates the EHR launching the app for a patient (with an encounter in context). */
  ehrLaunchUrl(appLaunchUrl: string, patientId?: string): string;
  /** The next authorization request is denied (access_denied). */
  denyNext(): void;
  /** Request log: method, path (no query) and status, for assertions. */
  requests: { method: string; path: string; status: number; auth: boolean }[];
  close(): Promise<void>;
};

/** The mock EHR's own id for a Synthea id: an EHR never shares the outside record's ids. */
export const mockId = (id: string) => `mock-${id}`;

/**
 * Serves a Synthea patient the way an EHR would: its own ids (mockId), literal "Type/id" references, and conditional
 * references (Synthea's Practitioner/Organization lookups) reduced to their display.
 */
export function loadSyntheaPatient(file: string): { patientId: string; resources: Resource[] } {
  const bundle = JSON.parse(readFileSync(file, "utf8")) as {
    entry: { fullUrl?: string; resource: Resource }[];
  };
  const index = new Map<string, string>();
  for (const e of bundle.entry)
    if (e.fullUrl) index.set(e.fullUrl, `${e.resource.resourceType}/${e.resource.id}`);
  const literal = (ref: string) => {
    const [type, id] = ref.split("/");
    return `${type}/${mockId(id!)}`;
  };
  const fix = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(fix);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "reference" && typeof v === "string") {
        if (index.has(v)) out[k] = literal(index.get(v)!);
        else if (/^[A-Za-z]+\/[^/?]+$/.test(v)) out[k] = literal(v);
      } else out[k] = fix(v);
    }
    return out;
  };
  const resources = bundle.entry
    .map((e) => e.resource)
    .filter((r) => MOCK_TYPES.includes(r.resourceType))
    .map((r) => ({ ...(fix(r) as Resource), id: mockId(r.id) }));
  const patient = resources.find((r) => r.resourceType === "Patient");
  if (!patient) throw new Error(`No Patient in ${file}`);
  return { patientId: patient.id, resources };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sha256b64url = (s: string) => createHash("sha256").update(s).digest("base64url");
const token = () => randomBytes(24).toString("base64url");

function capabilityStatement(iss: string, base: string) {
  const read = ["read", "search-type"];
  const types: Record<string, string[]> = {
    Patient: read,
    Condition: [...read, "create"],
    MedicationRequest: read,
    Medication: ["read"],
    AllergyIntolerance: [...read, "create"],
    Encounter: read,
    DocumentReference: [...read, "create"],
  };
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: "2026-10-12",
    publisher: "MediSync test mock (not Epic)",
    kind: "instance",
    software: { name: "MediSync mock SMART server", version: "test" },
    implementation: { description: "Test fixture standing in for a SMART sandbox", url: iss },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        security: {
          extension: [
            {
              url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris",
              extension: [
                { url: "authorize", valueUri: `${base}/oauth2/authorize` },
                { url: "token", valueUri: `${base}/oauth2/token` },
              ],
            },
          ],
        },
        resource: Object.entries(types).map(([type, codes]) => ({
          type,
          interaction: codes.map((code) => ({ code })),
          searchParam: codes.includes("search-type")
            ? [{ name: "patient", type: "reference" }]
            : [],
        })),
      },
    ],
  };
}

const COMPARTMENT_FIELD: Record<string, string> = {
  Condition: "subject",
  MedicationRequest: "subject",
  AllergyIntolerance: "patient",
  Encounter: "subject",
};

export async function startMockSmart(opts: MockSmartOptions): Promise<MockSmart> {
  const patients = new Map(
    opts.bundles.map((f) => loadSyntheaPatient(f)).map((p) => [p.patientId, p.resources]),
  );
  const defaultPatient = [...patients.keys()][0]!;
  const pageSize = opts.pageSize ?? 20;
  const launches = new Map<string, { patient: string; encounter?: string }>();
  const codes = new Map<
    string,
    {
      redirectUri: string;
      challenge: string;
      scope: string;
      patient?: string;
      encounter?: string;
      expires: number;
    }
  >();
  const tokens = new Map<string, { scope: string; patient?: string; expires: number }>();
  const signingKey = randomBytes(32);
  const requests: MockSmart["requests"] = [];
  let deny = false;
  let base = "";
  let iss = "";

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    type = "application/fhir+json",
  ) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const outcome = (code: string, text: string) => ({
    resourceType: "OperationOutcome",
    issue: [{ severity: "error", code, diagnostics: text }],
  });
  const redirect = (res: ServerResponse, to: string) => {
    res.writeHead(302, { location: to });
    res.end();
  };
  const idToken = (sub: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(
      JSON.stringify({
        iss,
        sub,
        aud: opts.clientId,
        iat: now,
        exp: now + 300,
        fhirUser: `${iss}/${MOCK_PRACTITIONER}`,
      }),
    );
    const sig = createHmac("sha256", signingKey).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c: Buffer) => (s += c.toString("utf8")));
      req.on("end", () => resolve(s));
    });

  function authorize(url: URL, res: ServerResponse) {
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    if (q.get("client_id") !== opts.clientId || !opts.redirectUris.includes(redirectUri))
      return send(res, 400, "invalid client_id or redirect_uri", "text/plain");
    const back = (params: Record<string, string>) => {
      const to = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
      if (q.get("state")) to.searchParams.set("state", q.get("state")!);
      redirect(res, to.href);
    };
    const scope = q.get("scope") ?? "";
    const scopes = scope.split(/\s+/);
    if (q.get("response_type") !== "code" || !q.get("state"))
      return back({ error: "invalid_request" });
    if (q.get("aud") !== iss) return back({ error: "invalid_request", error_description: "aud" });
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
      return back({ error: "invalid_request", error_description: "pkce" });
    if (deny) {
      deny = false;
      return back({ error: "access_denied" });
    }
    let patient: string | undefined;
    let encounter: string | undefined;
    const launch = q.get("launch");
    if (launch) {
      const ctx = launches.get(launch);
      if (!ctx || !scopes.includes("launch"))
        return back({ error: "invalid_request", error_description: "launch" });
      ({ patient, encounter } = ctx);
    } else if (scopes.includes("launch/patient")) patient = defaultPatient; // a real server shows a patient picker
    const code = token();
    codes.set(code, {
      redirectUri,
      challenge: q.get("code_challenge")!,
      scope,
      patient,
      encounter,
      expires: Date.now() + 60_000,
    });
    back({ code });
  }

  async function tokenEndpoint(req: IncomingMessage, res: ServerResponse) {
    const f = new URLSearchParams(await readBody(req));
    const c = codes.get(f.get("code") ?? "");
    const fail = (error: string) => send(res, 400, { error }, "application/json");
    if (f.get("grant_type") !== "authorization_code" || !c) return fail("invalid_grant");
    codes.delete(f.get("code")!);
    if (
      c.expires < Date.now() ||
      f.get("redirect_uri") !== c.redirectUri ||
      f.get("client_id") !== opts.clientId
    )
      return fail("invalid_grant");
    if (sha256b64url(f.get("code_verifier") ?? "") !== c.challenge) return fail("invalid_grant");
    const access = token();
    tokens.set(access, { scope: c.scope, patient: c.patient, expires: Date.now() + 3_600_000 });
    send(
      res,
      200,
      {
        access_token: access,
        token_type: "Bearer",
        expires_in: 3600,
        scope: c.scope,
        ...(c.patient ? { patient: c.patient } : {}),
        ...(c.encounter ? { encounter: c.encounter } : {}),
        ...(c.scope.split(" ").includes("openid")
          ? { id_token: idToken(MOCK_PRACTITIONER.split("/")[1]!) }
          : {}),
      },
      "application/json",
    );
  }

  function fhir(req: IncomingMessage, url: URL, res: ServerResponse) {
    const path = url.pathname.slice("/fhir/".length);
    if (path === "metadata") return send(res, 200, capabilityStatement(iss, base));
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const t = auth ? tokens.get(auth) : undefined;
    if (!t || t.expires < Date.now())
      return send(res, 401, outcome("login", "missing or invalid token"));
    const [type, id] = path.split("/") as [string, string | undefined];
    const scopes = t.scope.split(/\s+/);
    const allowed = [
      `patient/${type}.read`,
      `patient/${type}.rs`,
      "patient/*.read",
      "patient/*.rs",
    ].some((s) => scopes.includes(s));
    if (!MOCK_TYPES.includes(type)) return send(res, 404, outcome("not-supported", "unknown type"));
    if (!allowed) return send(res, 403, outcome("forbidden", "scope"));
    const data = (t.patient && patients.get(t.patient)) || [];
    const inCompartment = (r: Resource) =>
      r.resourceType === "Patient"
        ? r.id === t.patient
        : r.resourceType === "Medication" ||
          (r[COMPARTMENT_FIELD[r.resourceType]!] as { reference?: string })?.reference ===
            `Patient/${t.patient}`;
    if (id) {
      const r = data.find((x) => x.resourceType === type && x.id === id);
      return r && inCompartment(r)
        ? send(res, 200, r)
        : send(res, 404, outcome("not-found", "not found"));
    }
    if (opts.failTypes?.includes(type))
      return send(res, 500, outcome("exception", "simulated failure"));
    const patient = url.searchParams.get("patient");
    if (type !== "Medication" && patient !== t.patient)
      return send(res, 403, outcome("forbidden", "patient compartment"));
    const category = url.searchParams.get("category");
    const matches = data.filter(
      (r) =>
        r.resourceType === type &&
        inCompartment(r) &&
        (!category ||
          ((r.category as { coding?: { code?: string }[] }[] | undefined) ?? []).some((c) =>
            c.coding?.some((x) => x.code === category),
          )),
    );
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = matches.slice((page - 1) * pageSize, page * pageSize);
    const link = [{ relation: "self", url: url.href }];
    if (page * pageSize < matches.length) {
      const next = new URL(url.href);
      next.searchParams.set("page", String(page + 1));
      link.push({ relation: "next", url: next.href });
    }
    const entry = slice.map((r) => ({
      fullUrl: `${iss}/${r.resourceType}/${r.id}`,
      resource: r,
      search: { mode: "match" },
    }));
    if (!matches.length)
      entry.push({
        fullUrl: "",
        resource: { ...outcome("not-found", "no results"), id: "none" } as Resource,
        search: { mode: "outcome" },
      });
    send(res, 200, {
      resourceType: "Bundle",
      type: "searchset",
      total: matches.length,
      link,
      entry,
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    res.on("finish", () =>
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        status: res.statusCode,
        auth: !!req.headers.authorization,
      }),
    );
    if (req.method === "GET" && url.pathname === "/fhir/.well-known/smart-configuration")
      return send(
        res,
        200,
        {
          issuer: base,
          authorization_endpoint: `${base}/oauth2/authorize`,
          token_endpoint: `${base}/oauth2/token`,
          grant_types_supported: ["authorization_code"],
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: [
            "openid",
            "fhirUser",
            "launch",
            "launch/patient",
            ...MOCK_TYPES.map((t) => `patient/${t}.read`),
          ],
          capabilities: [
            "launch-ehr",
            "launch-standalone",
            "client-public",
            "context-ehr-patient",
            "context-standalone-patient",
            "permission-patient",
            "sso-openid-connect",
          ],
        },
        "application/json",
      );
    if (req.method === "GET" && url.pathname === "/oauth2/authorize") return authorize(url, res);
    if (req.method === "POST" && url.pathname === "/oauth2/token")
      return void tokenEndpoint(req, res);
    if (req.method === "GET" && url.pathname === "/ehr/launch") {
      const app = url.searchParams.get("app") ?? "";
      const patient = url.searchParams.get("patient") ?? defaultPatient;
      if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(app) || !patients.has(patient))
        return send(res, 400, "bad launch", "text/plain");
      const encounter = patients
        .get(patient)!
        .filter((r) => r.resourceType === "Encounter")
        .at(-1)?.id;
      const launch = token();
      launches.set(launch, { patient, encounter });
      const to = new URL(app);
      to.searchParams.set("iss", iss);
      to.searchParams.set("launch", launch);
      return redirect(res, to.href);
    }
    if (req.method === "GET" && url.pathname.startsWith("/fhir/")) return fhir(req, url, res);
    send(res, 404, "not found", "text/plain");
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  iss = `${base}/fhir`;

  return {
    base,
    iss,
    patientIds: [...patients.keys()],
    ehrLaunchUrl: (app, patientId = defaultPatient) =>
      `${base}/ehr/launch?app=${encodeURIComponent(app)}&patient=${encodeURIComponent(patientId)}`,
    denyNext: () => void (deny = true),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
