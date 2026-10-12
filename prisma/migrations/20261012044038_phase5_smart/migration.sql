-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'LOGIN';

-- AlterTable
ALTER TABLE "reconciliation_runs" ADD COLUMN     "current_source_record_id" UUID,
ADD COLUMN     "incoming_patient_id" UUID;

-- CreateTable
CREATE TABLE "smart_sessions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "launch_type" TEXT NOT NULL,
    "iss" TEXT NOT NULL,
    "state_enc" TEXT,
    "authorized_at" TIMESTAMP(3),
    "scope" TEXT,
    "fhir_user" TEXT,
    "fhir_patient_id" TEXT,
    "encounter_id" TEXT,
    "patient_id" UUID,
    "source_record_id" UUID,
    "fetch_summary" JSONB,

    CONSTRAINT "smart_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "smart_sessions_expires_at_idx" ON "smart_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_incoming_patient_id_fkey" FOREIGN KEY ("incoming_patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_current_source_record_id_fkey" FOREIGN KEY ("current_source_record_id") REFERENCES "source_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_sessions" ADD CONSTRAINT "smart_sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smart_sessions" ADD CONSTRAINT "smart_sessions_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
