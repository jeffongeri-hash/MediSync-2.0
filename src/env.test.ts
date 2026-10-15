import { describe, expect, it } from "vitest";
import { parseEnv } from "@/env";

describe("parseEnv", () => {
  it("accepts a postgres URL and treats blank optionals as unset", () => {
    const env = parseEnv({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      ANTHROPIC_API_KEY: "",
    });
    expect(env.DATABASE_URL).toBe("postgresql://u:p@localhost:5432/db");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects a missing or non-postgres DATABASE_URL", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseEnv({ DATABASE_URL: "mysql://localhost/db" })).toThrow(/DATABASE_URL/);
  });

  it("never echoes secret values in errors", () => {
    expect(() => parseEnv({ DATABASE_URL: "not-a-url-sk-secret" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("sk-secret") }),
    );
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgresql://u:p@localhost:5432/db",
        MEDISYNC_DATA_KEY: "not-32-bytes",
      }),
    ).toThrow("Invalid environment: MEDISYNC_DATA_KEY");
  });
});
