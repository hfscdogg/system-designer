-- Revisions: a finished budget is changed by a new run seeded from its
-- approved scope. Each revision is a complete run of its own (receipt,
-- approval, build, PDF); the parent is marked SUPERSEDED when it is replaced.

ALTER TABLE runs ADD COLUMN parent_run_id text REFERENCES runs(id);
ALTER TABLE runs ADD COLUMN revision integer NOT NULL DEFAULT 1;

-- The requester tapped "Revise this budget": their next message in the
-- thread revises that run. One pending revision per thread.
CREATE TABLE pending_revisions (
  platform    text NOT NULL,
  space_id    text NOT NULL,
  thread_id   text NOT NULL,
  run_id      text NOT NULL REFERENCES runs(id),
  person_id   text NOT NULL REFERENCES persons(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, space_id, thread_id)
);
