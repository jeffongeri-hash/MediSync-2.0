-- CreateEnum
CREATE TYPE "ReconcileCategory" AS ENUM ('PROBLEM', 'PMH', 'MEDICATION', 'ALLERGY');

-- CreateEnum
CREATE TYPE "ReconcileMatch" AS ENUM ('SAME', 'CHANGED', 'NEW', 'CURRENT_ONLY');

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('SUMMARY', 'FLAG');

-- CreateEnum
CREATE TYPE "DecisionAction" AS ENUM ('ACCEPT', 'REJECT', 'EDIT');

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "requested_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cutoff" TIMESTAMPTZ(3) NOT NULL,
    "rules_version" TEXT NOT NULL,
    "responder" TEXT NOT NULL,
    "ai_status" TEXT NOT NULL,
    "model" TEXT,
    "served_model" TEXT,
    "prompt_version" TEXT,
    "input_sha256" TEXT,
    "ai_raw" TEXT,
    "ai_error" TEXT,
    "summary" JSONB,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "category" "ReconcileCategory" NOT NULL,
    "match" "ReconcileMatch" NOT NULL,
    "current_id" UUID,
    "incoming_id" UUID,
    "current" JSONB,
    "incoming" JSONB,
    "flags" JSONB NOT NULL,

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_claims" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "ClaimKind" NOT NULL,
    "topic" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "cited_aliases" TEXT[],
    "source_ids" TEXT[],
    "valid" BOOLEAN NOT NULL,
    "problems" TEXT[],

    CONSTRAINT "reconciliation_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_decisions" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "item_id" UUID,
    "claim_id" UUID,
    "action" "DecisionAction" NOT NULL,
    "actor" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "edited_resource" JSONB,

    CONSTRAINT "reconciliation_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_runs_patient_id_created_at_idx" ON "reconciliation_runs"("patient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_items_run_id_ordinal_key" ON "reconciliation_items"("run_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_claims_run_id_ordinal_key" ON "reconciliation_claims"("run_id", "ordinal");

-- CreateIndex
CREATE INDEX "reconciliation_decisions_run_id_decided_at_idx" ON "reconciliation_decisions"("run_id", "decided_at");

-- AddForeignKey
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_current_id_fkey" FOREIGN KEY ("current_id") REFERENCES "canonical_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_incoming_id_fkey" FOREIGN KEY ("incoming_id") REFERENCES "canonical_resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_claims" ADD CONSTRAINT "reconciliation_claims_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "reconciliation_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_decisions" ADD CONSTRAINT "reconciliation_decisions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "reconciliation_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A decision targets exactly one item or one claim; EDIT (provider-authored copy) applies to items only.
ALTER TABLE "reconciliation_decisions"
  ADD CONSTRAINT "reconciliation_decisions_one_target" CHECK (("item_id" IS NULL) <> ("claim_id" IS NULL)),
  ADD CONSTRAINT "reconciliation_decisions_edit_copy" CHECK (
    ("action" = 'EDIT') = ("edited_resource" IS NOT NULL) AND ("action" <> 'EDIT' OR "item_id" IS NOT NULL)
  );

-- Decisions are append-only, like audit_log: a changed mind is a new row.
CREATE FUNCTION reconciliation_decisions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation_decisions is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reconciliation_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON "reconciliation_decisions"
  FOR EACH ROW EXECUTE FUNCTION reconciliation_decisions_append_only();
