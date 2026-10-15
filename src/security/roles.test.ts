import { describe, expect, it } from "vitest";
import { allows, defaultRole, demoMode } from "@/security/roles";

describe("roles", () => {
  it("gives a Practitioner or PractitionerRole the provider role and anyone else viewer", () => {
    expect(defaultRole("https://ehr.example/fhir/Practitioner/abc-1")).toBe("PROVIDER");
    expect(defaultRole("Practitioner/abc")).toBe("PROVIDER");
    expect(defaultRole("https://ehr.example/fhir/PractitionerRole/r.1")).toBe("PROVIDER");
    expect(defaultRole("https://ehr.example/fhir/Patient/abc")).toBe("VIEWER");
    expect(defaultRole("https://ehr.example/fhir/RelatedPerson/abc")).toBe("VIEWER");
    expect(defaultRole("https://ehr.example/fhir/Practitioner/abc/_history/2")).toBe("VIEWER");
    expect(defaultRole(null)).toBe("VIEWER");
  });

  it("orders viewer < provider < admin", () => {
    expect(allows("ADMIN", "PROVIDER")).toBe(true);
    expect(allows("PROVIDER", "PROVIDER")).toBe(true);
    expect(allows("VIEWER", "PROVIDER")).toBe(false);
    expect(allows("PROVIDER", "ADMIN")).toBe(false);
  });

  it("turns demo mode on outside production unless DEMO_MODE says otherwise", () => {
    expect(demoMode({ NODE_ENV: "development" })).toBe(true);
    expect(demoMode({ NODE_ENV: "test" })).toBe(true);
    expect(demoMode({ NODE_ENV: "production" })).toBe(false);
    expect(demoMode({ NODE_ENV: "production", DEMO_MODE: "1" })).toBe(true);
    expect(demoMode({ NODE_ENV: "production", DEMO_MODE: "true" })).toBe(true);
    expect(demoMode({ NODE_ENV: "development", DEMO_MODE: "0" })).toBe(false);
    expect(demoMode({ NODE_ENV: "development", DEMO_MODE: "FALSE" })).toBe(false);
  });
});
