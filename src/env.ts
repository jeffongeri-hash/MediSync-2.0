import { z } from "zod";
import { readDataKey } from "@/security/at-rest";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

export const envSchema = z.object({
  DATABASE_URL: z.url().refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres URL"),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: optional,
  SMART_CLIENT_ID: optional,
  SMART_ISS: z.url().optional(),
  SMART_REDIRECT_URI: z.url().optional(),
  MEDISYNC_REVIEWER_TOKEN: optional,
  MEDISYNC_EXPORTER_TOKEN: optional,
  MEDISYNC_AUDITOR_TOKEN: optional,
  MEDISYNC_DATA_KEY: optional,
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    // Report variable names only; values may be secrets.
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid environment: ${names.join(", ")}`);
  }
  if (result.data.MEDISYNC_DATA_KEY) {
    try {
      readDataKey(result.data.MEDISYNC_DATA_KEY);
    } catch {
      throw new Error("Invalid environment: MEDISYNC_DATA_KEY");
    }
  }
  return result.data;
}
