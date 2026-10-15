-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'PROVIDER', 'ADMIN');

-- CreateTable
CREATE TABLE "user_roles" (
    "actor" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("actor")
);
