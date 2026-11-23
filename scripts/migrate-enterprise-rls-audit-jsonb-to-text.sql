-- Operator-only, offline migration for the opt-in RLS tenant audit ledger.
-- Take and verify a database backup first; stop all application writers. Run
-- once as the schema owner through a trusted, TLS-verified database connection
-- using psql -X -v ON_ERROR_STOP=1 -f this-file. Never run from an HTTP request.
-- A corrupt or unexpected old ledger aborts the transaction without dropping
-- any events. The application refuses the old jsonb type until this commits.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE public.interpreter_enterprise_rls_directory IN SHARE MODE;
LOCK TABLE public.interpreter_enterprise_rls_audit IN ACCESS EXCLUSIVE MODE;
DO $migration$
BEGIN
  IF (SELECT a.atttypid FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.interpreter_enterprise_rls_audit'::regclass
        AND a.attname = 'content' AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'jsonb'::regtype THEN
    RAISE EXCEPTION 'Expected the old jsonb audit schema';
  END IF;
  IF EXISTS (SELECT 1 FROM public.interpreter_enterprise_rls_directory d
    WHERE (d.content::jsonb->'audit') IS DISTINCT FROM
      COALESCE((SELECT jsonb_agg(a.content ORDER BY a.id)
        FROM public.interpreter_enterprise_rls_audit a
        WHERE a.organization_id = d.organization_id), '[]'::jsonb))
    OR EXISTS (SELECT 1 FROM public.interpreter_enterprise_rls_audit a
      WHERE NOT EXISTS (SELECT 1 FROM public.interpreter_enterprise_rls_directory d
        WHERE d.organization_id = a.organization_id)) THEN
    RAISE EXCEPTION 'Old tenant audit and directory disagree';
  END IF;
END
$migration$;

ALTER TABLE public.interpreter_enterprise_rls_audit
  DROP CONSTRAINT interpreter_enterprise_rls_audit_check;
ALTER TABLE public.interpreter_enterprise_rls_audit
  ALTER COLUMN content TYPE text USING content::text;
-- The old jsonb column reordered object keys. Restore each event's exact
-- canonical JSON.stringify spelling from the directory's original text,
-- preserving each tenant's append order and existing audit sequence IDs.
WITH numbered AS (
  SELECT a.id, a.organization_id,
    row_number() OVER (PARTITION BY a.organization_id ORDER BY a.id) AS ordinality
  FROM public.interpreter_enterprise_rls_audit a
), canonical AS (
  SELECT d.organization_id, e.ordinality, e.event::text AS content
  FROM public.interpreter_enterprise_rls_directory d
  CROSS JOIN LATERAL json_array_elements(d.content::json->'audit')
    WITH ORDINALITY AS e(event, ordinality)
)
UPDATE public.interpreter_enterprise_rls_audit a SET content = c.content
FROM numbered n JOIN canonical c
  ON c.organization_id = n.organization_id AND c.ordinality = n.ordinality
WHERE a.id = n.id;

ALTER TABLE public.interpreter_enterprise_rls_audit
  ADD CONSTRAINT interpreter_enterprise_rls_audit_check
  CHECK (octet_length(content) BETWEEN 2 AND 16384 AND
    left(content, char_length(organization_id) + 21) = '{"organizationId":"' || organization_id || '",' AND
    content LIKE '%"subject":"_%' AND content NOT LIKE '%"subject":""%' AND
    content LIKE '%"action":"_%' AND content NOT LIKE '%"action":""%' AND
    content LIKE '%"at":"_%' AND content NOT LIKE '%"at":""%' AND
    (content LIKE '%"outcome":"allowed"%' OR content LIKE '%"outcome":"denied"%'));
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.interpreter_enterprise_rls_directory d
    WHERE COALESCE((SELECT array_agg(e.event::text ORDER BY e.ordinality)
      FROM json_array_elements(d.content::json->'audit')
        WITH ORDINALITY AS e(event, ordinality)), ARRAY[]::text[])
      IS DISTINCT FROM COALESCE((SELECT array_agg(a.content ORDER BY a.id)
        FROM public.interpreter_enterprise_rls_audit a
        WHERE a.organization_id = d.organization_id), ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'Migrated tenant audit and directory disagree';
  END IF;
END
$migration$;
COMMIT;
