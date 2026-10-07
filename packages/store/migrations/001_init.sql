-- System Designer: durable business state. Temporal owns workflow progress;
-- this database owns identity, evidence, receipts, approvals and the audit log.

CREATE TABLE persons (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  -- requester: may start runs. admin: may change margin config and identities.
  roles         text[] NOT NULL DEFAULT '{requester}',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Authenticated provider identities. Display names are never authority.
CREATE TABLE channel_identities (
  platform          text NOT NULL,
  provider_user_id  text NOT NULL,
  person_id         text NOT NULL REFERENCES persons(id),
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, provider_user_id)
);

-- Internal conversations the app may talk in (pilot hold: no customer channels).
CREATE TABLE allowed_spaces (
  platform    text NOT NULL,
  space_id    text NOT NULL,
  label       text,
  PRIMARY KEY (platform, space_id)
);

-- Durable session generation per thread. A reset bumps it and stales open work.
CREATE TABLE session_generations (
  platform    text NOT NULL,
  space_id    text NOT NULL,
  thread_id   text NOT NULL,
  generation  integer NOT NULL DEFAULT 1,
  PRIMARY KEY (platform, space_id, thread_id)
);

-- Immutable original intake (PRD §7.2), written before any LLM sees the text.
CREATE TABLE intake_messages (
  id                    text PRIMARY KEY,
  platform              text NOT NULL,
  provider_message_id   text NOT NULL,
  space_id              text NOT NULL,
  thread_id             text NOT NULL,
  requester_provider_id text NOT NULL,
  requester_email       text,
  person_id             text NOT NULL REFERENCES persons(id),
  session_generation    integer NOT NULL,
  text                  text NOT NULL,
  attachments           jsonb NOT NULL DEFAULT '[]',
  provider_time         timestamptz,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  raw_blob_key          text NOT NULL,
  raw_sha256            text NOT NULL,
  text_sha256           text NOT NULL,
  release_id            text NOT NULL,
  UNIQUE (platform, provider_message_id)
);

CREATE TABLE runs (
  id                  text PRIMARY KEY,
  platform            text NOT NULL,
  space_id            text NOT NULL,
  thread_id           text NOT NULL,
  person_id           text NOT NULL REFERENCES persons(id),
  session_generation  integer NOT NULL,
  intake_id           text NOT NULL REFERENCES intake_messages(id),
  state               text NOT NULL,
  release_id          text NOT NULL,
  status_message_id   text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- At most one run collecting scope per thread.
CREATE UNIQUE INDEX runs_one_open_per_thread ON runs (platform, space_id, thread_id)
  WHERE state IN ('RECEIVED', 'AUTHENTICATED_AND_CAPTURED', 'NEEDS_CLARIFICATION', 'AWAITING_SCOPE_APPROVAL');

-- Single-use claim of every provider message (PRD §7.3). Lives outside any run workspace.
CREATE TABLE message_claims (
  platform             text NOT NULL,
  provider_message_id  text NOT NULL,
  run_id               text REFERENCES runs(id),
  purpose              text NOT NULL,
  claimed_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, provider_message_id)
);

CREATE TABLE receipts (
  id                  text PRIMARY KEY,
  run_id              text NOT NULL REFERENCES runs(id),
  version             integer NOT NULL,
  status              text NOT NULL,
  body                jsonb NOT NULL,
  body_sha256         text NOT NULL,
  scope_hash          text,
  session_generation  integer NOT NULL,
  message_id          text,
  superseded_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, version)
);

CREATE TABLE approvals (
  id                  text PRIMARY KEY,
  run_id              text NOT NULL UNIQUE REFERENCES runs(id),
  receipt_id          text NOT NULL UNIQUE REFERENCES receipts(id),
  scope_hash          text NOT NULL,
  approver_person_id  text NOT NULL REFERENCES persons(id),
  platform            text NOT NULL,
  space_id            text NOT NULL,
  thread_id           text NOT NULL,
  session_generation  integer NOT NULL,
  provider_event_id   text NOT NULL,
  method              text NOT NULL,
  approved_at         timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log (PRD §16.1).
CREATE TABLE events (
  seq         bigserial PRIMARY KEY,
  run_id      text,
  type        text NOT NULL,
  actor       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  release_id  text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_run ON events (run_id, seq);

CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER intake_messages_immutable BEFORE UPDATE OR DELETE ON intake_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER approvals_immutable BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Receipt content never changes; only supersession and the posted message id may be set once.
CREATE FUNCTION receipts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'receipts are append-only';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
     OR (OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id) THEN
    RAISE EXCEPTION 'receipt % content is immutable', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER receipts_guarded BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_guard();

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
