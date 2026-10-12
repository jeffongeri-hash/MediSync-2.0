import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const envSchema = z.object({
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres URL"),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: optional,
  // SMART on FHIR (Phase 5): parsed in full by src/smart/config.ts, only when a launch route needs them.
  SMART_CLIENT_ID: optional,
  SMART_ISS: optional,
  SMART_REDIRECT_URI: optional,
  SMART_SCOPE: optional,
  SESSION_SECRET: optional,
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report variable names only; values may be secrets.
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${names.join(", ")}`);
  }
  return result.data;
}
