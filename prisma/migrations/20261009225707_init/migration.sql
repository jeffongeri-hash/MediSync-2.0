-- CreateEnum
CREATE TYPE "SourceFormat" AS ENUM ('FHIR_BUNDLE', 'FHIR_NDJSON', 'CCDA');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('READ', 'CREATE', 'UPDATE', 'DELETE', 'EXPORT');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_patient_id" TEXT NOT NULL,
    "display_name" TEXT,
    "birth_date" DATE,
    "gender" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_records" (
    "id" UUID NOT NULL,
    "patient_id" UUID,
    "format" "SourceFormat" NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_record_id" TEXT,
    "filename" TEXT,
    "content_type" TEXT NOT NULL,
    "raw_text" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "summary" JSONB,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canonical_resources" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "fhir_id" TEXT NOT NULL,
    "fhir_version" TEXT NOT NULL DEFAULT '4.0.1',
    "resource" JSONB NOT NULL,
    "source_path" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canonical_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mapping_issues" (
    "id" UUID NOT NULL,
    "patient_id" UUID,
    "source_record_id" UUID NOT NULL,
    "canonical_resource_id" UUID,
    "severity" "IssueSeverity" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "details" JSONB,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "patient_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "source" TEXT,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_source_system_source_patient_id_key" ON "patients"("source_system", "source_patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_records_sha256_key" ON "source_records"("sha256");

-- CreateIndex
CREATE INDEX "source_records_patient_id_idx" ON "source_records"("patient_id");

-- CreateIndex
CREATE INDEX "canonical_resources_patient_id_resource_type_idx" ON "canonical_resources"("patient_id", "resource_type");

-- CreateIndex
CREATE UNIQUE INDEX "canonical_resources_source_record_id_resource_type_fhir_id_key" ON "canonical_resources"("source_record_id", "resource_type", "fhir_id");

-- CreateIndex
CREATE INDEX "mapping_issues_status_code_idx" ON "mapping_issues"("status", "code");

-- CreateIndex
CREATE INDEX "mapping_issues_patient_id_idx" ON "mapping_issues"("patient_id");

-- CreateIndex
CREATE INDEX "audit_log_patient_id_occurred_at_idx" ON "audit_log"("patient_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at");

-- AddForeignKey
ALTER TABLE "source_records" ADD CONSTRAINT "source_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_resources" ADD CONSTRAINT "canonical_resources_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canonical_resources" ADD CONSTRAINT "canonical_resources_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_issues" ADD CONSTRAINT "mapping_issues_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_issues" ADD CONSTRAINT "mapping_issues_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "source_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mapping_issues" ADD CONSTRAINT "mapping_issues_canonical_resource_id_fkey" FOREIGN KEY ("canonical_resource_id") REFERENCES "canonical_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- audit_log is append-only: block UPDATE and DELETE at the database level.
CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
