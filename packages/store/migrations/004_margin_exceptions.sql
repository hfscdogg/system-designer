-- Margin exceptions (2026 sales comp policy): a build below its market's
-- gross-margin floor is held until an admin approves or declines it in Chat.
-- The decision is the written approval the policy requires.

-- Where the app can reach a person directly (their 1:1 conversation with it).
ALTER TABLE channel_identities ADD COLUMN dm_space_id text;

CREATE TABLE margin_exceptions (
  id                text PRIMARY KEY,
  run_id            text NOT NULL UNIQUE REFERENCES runs(id),
  -- The exact bound proposal the exception is for; a different proposal needs a new exception.
  proposal_sha256   text NOT NULL,
  market            text NOT NULL,
  gross_margin_pct  numeric NOT NULL,
  minimum_pct       numeric NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE margin_exception_decisions (
  exception_id       text PRIMARY KEY REFERENCES margin_exceptions(id),
  decision           text NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_by         text NOT NULL REFERENCES persons(id),
  provider_event_id  text NOT NULL,
  method             text NOT NULL,
  decided_at         timestamptz NOT NULL DEFAULT now()
);

-- Only an active admin may decide, enforced in the database as well as the gateway.
CREATE FUNCTION margin_decision_admin_only() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = NEW.decided_by AND active AND 'admin' = ANY(roles)) THEN
    RAISE EXCEPTION 'only an active admin may decide a margin exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER margin_decisions_admin BEFORE INSERT ON margin_exception_decisions
  FOR EACH ROW EXECUTE FUNCTION margin_decision_admin_only();
CREATE TRIGGER margin_exceptions_immutable BEFORE UPDATE OR DELETE ON margin_exceptions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER margin_decisions_immutable BEFORE UPDATE OR DELETE ON margin_exception_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
