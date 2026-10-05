-- M2: build pipeline state.

-- One build per approved scope (PRD §13.1, §13.8).
CREATE TABLE builds (
  run_id       text PRIMARY KEY REFERENCES runs(id),
  approval_id  text NOT NULL UNIQUE REFERENCES approvals(id),
  scope_hash   text NOT NULL,
  release_id   text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now()
);

-- D-Tools reads admitted as evidence for a run (PRD §11.2). Never shared across runs.
CREATE TABLE catalog_evidence (
  run_id      text NOT NULL REFERENCES runs(id),
  record_id   text NOT NULL,
  endpoint    text NOT NULL,
  sha256      text NOT NULL,
  blob_key    text NOT NULL,
  fetched_at  timestamptz NOT NULL,
  admitted    boolean NOT NULL,
  reason      text,
  PRIMARY KEY (run_id, record_id)
);

-- Published stage outputs (PRD §16.2). A name is published once; content never changes.
CREATE TABLE artifacts (
  run_id      text NOT NULL REFERENCES runs(id),
  stage       text NOT NULL,
  name        text NOT NULL,
  blob_key    text NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stage, name)
);

-- Margin and tax rules, versioned and append-only (PRD §15.4). Latest version wins.
CREATE TABLE commercial_policies (
  version     serial PRIMARY KEY,
  policy      jsonb NOT NULL,
  set_by      text NOT NULL REFERENCES persons(id),
  reason      text NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now()
);

-- Only an admin may publish a policy, enforced in the database as well as the CLI.
CREATE FUNCTION commercial_policy_admin_only() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM persons WHERE id = NEW.set_by AND active AND 'admin' = ANY(roles)) THEN
    RAISE EXCEPTION 'only an active admin may publish a commercial policy';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commercial_policies_admin BEFORE INSERT ON commercial_policies
  FOR EACH ROW EXECUTE FUNCTION commercial_policy_admin_only();
CREATE TRIGGER commercial_policies_immutable BEFORE UPDATE OR DELETE ON commercial_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER builds_immutable BEFORE UPDATE OR DELETE ON builds
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER catalog_evidence_immutable BEFORE UPDATE OR DELETE ON catalog_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
