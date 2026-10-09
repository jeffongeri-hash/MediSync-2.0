import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { parseEnv } from "@/env";

export type Db = PrismaClient;

export function createDb(databaseUrl = parseEnv().DATABASE_URL): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

// Reuse one client across Next.js dev hot reloads.
const globalForDb = globalThis as unknown as { medisyncDb?: Db };

export function getDb(): Db {
  globalForDb.medisyncDb ??= createDb();
  return globalForDb.medisyncDb;
}
