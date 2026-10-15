-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "prev_hash" TEXT;

-- Hash chain over audit_log. Each field is length-prefixed (bytes:value, or "-" for null) so no value can bleed into
-- the next; src/audit/chain.ts computes the same string to verify an export. Timestamps as ISO-8601 UTC, ms precision.
CREATE FUNCTION audit_log_field(v text) RETURNS text AS $$
  SELECT CASE WHEN v IS NULL THEN '-' ELSE octet_length(v)::text || ':' || v END;
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION audit_log_hash(
  prev text, id bigint, occurred_at timestamp, actor text, action text, patient_id uuid,
  entity_type text, entity_id text, source text, details jsonb
) RETURNS text AS $$
  SELECT encode(sha256(convert_to(
    audit_log_field(prev) || audit_log_field(id::text) ||
    audit_log_field(to_char(occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ||
    audit_log_field(actor) || audit_log_field(action) || audit_log_field(patient_id::text) ||
    audit_log_field(entity_type) || audit_log_field(entity_id) || audit_log_field(source) ||
    audit_log_field(details::text), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Backfill the rows written before the chain, in id order. The append-only trigger is lifted for this migration
-- only (ALTER TABLE holds an exclusive lock, so nothing else writes meanwhile).
ALTER TABLE "audit_log" DISABLE TRIGGER audit_log_no_update_delete;
DO $$
DECLARE r record; prev text := NULL;
BEGIN
  FOR r IN SELECT * FROM "audit_log" ORDER BY id LOOP
    UPDATE "audit_log" SET prev_hash = prev,
      hash = audit_log_hash(prev, r.id, r.occurred_at, r.actor, r.action::text, r.patient_id,
                            r.entity_type, r.entity_id, r.source, r.details)
    WHERE id = r.id
    RETURNING hash INTO prev;
  END LOOP;
END $$;
ALTER TABLE "audit_log" ENABLE TRIGGER audit_log_no_update_delete;

-- Appends are serialized by a transaction-level advisory lock, and the id is re-drawn under it, so id order is chain
-- order even when transactions commit out of order. Assumes READ COMMITTED (the default), where the head lookup
-- sees every chain row committed before the lock was granted.
CREATE FUNCTION audit_log_chain() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(726201146);
  NEW.id := nextval(pg_get_serial_sequence('audit_log', 'id'));
  NEW.prev_hash := (SELECT hash FROM "audit_log" ORDER BY id DESC LIMIT 1);
  NEW.hash := audit_log_hash(NEW.prev_hash, NEW.id, NEW.occurred_at, NEW.actor, NEW.action::text, NEW.patient_id,
                             NEW.entity_type, NEW.entity_id, NEW.source, NEW.details);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();
