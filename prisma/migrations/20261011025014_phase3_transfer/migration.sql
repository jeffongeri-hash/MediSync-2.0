-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
ALTER TYPE "IssueStage" ADD VALUE 'EXPORT';

-- CreateTable
CREATE TABLE "transfer_jobs" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "dry_run" BOOLEAN NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "target_profile" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "exported_at" TIMESTAMPTZ(3),
    "resources_selected" INTEGER,
    "resources_exported" INTEGER,
    "resources_excluded" INTEGER,
    "completeness" DOUBLE PRECISION,
    "summary" JSONB,
    "report" TEXT,
    "bundle" TEXT,
    "bundle_sha256" TEXT,
    "bundle_bytes" INTEGER,
    "error" TEXT,

    CONSTRAINT "transfer_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_jobs_patient_id_created_at_idx" ON "transfer_jobs"("patient_id", "created_at");

-- AddForeignKey
ALTER TABLE "transfer_jobs" ADD CONSTRAINT "transfer_jobs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
