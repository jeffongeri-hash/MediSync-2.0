-- CreateEnum
CREATE TYPE "IssueStage" AS ENUM ('INGEST', 'MAPPING', 'DEDUPE');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('MAPPED', 'UNMAPPED', 'NO_CODE', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "canonical_resources" ADD COLUMN     "code" TEXT,
ADD COLUMN     "code_system" TEXT,
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "duplicate_of_id" UUID,
ADD COLUMN     "mapped" JSONB,
ADD COLUMN     "mapping_status" "MappingStatus",
ADD COLUMN     "mapping_version" TEXT,
ADD COLUMN     "source_date" TIMESTAMPTZ(3),
ADD COLUMN     "source_system" TEXT;

-- AlterTable
ALTER TABLE "mapping_issues" ADD COLUMN     "stage" "IssueStage" NOT NULL DEFAULT 'INGEST';

-- CreateIndex
CREATE INDEX "canonical_resources_patient_id_dedupe_key_idx" ON "canonical_resources"("patient_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "canonical_resources_mapping_status_idx" ON "canonical_resources"("mapping_status");

-- CreateIndex
CREATE INDEX "mapping_issues_stage_canonical_resource_id_idx" ON "mapping_issues"("stage", "canonical_resource_id");

-- AddForeignKey
ALTER TABLE "canonical_resources" ADD CONSTRAINT "canonical_resources_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "canonical_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
