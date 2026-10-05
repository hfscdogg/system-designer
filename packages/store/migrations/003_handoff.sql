-- M3: the held internal hand-off (PRD §13.8). Exactly one per run.
-- This is not customer delivery: it records the PDF posted into the
-- requester's internal thread. No customer-delivery table exists.
CREATE TABLE held_handoffs (
  run_id               text PRIMARY KEY REFERENCES runs(id),
  pdf_sha256           text NOT NULL,
  platform             text NOT NULL,
  space_id             text NOT NULL,
  thread_id            text NOT NULL,
  provider_message_id  text NOT NULL,
  attachment_ref       text NOT NULL,
  posted_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER held_handoffs_immutable BEFORE UPDATE OR DELETE ON held_handoffs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
