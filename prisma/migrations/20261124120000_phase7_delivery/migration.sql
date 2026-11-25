-- AlterTable
ALTER TABLE "transfer_jobs" ADD COLUMN     "approved_job_id" UUID,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "delivery" JSONB,
ADD COLUMN     "target" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transfer_jobs_approved_job_id_key" ON "transfer_jobs"("approved_job_id");

