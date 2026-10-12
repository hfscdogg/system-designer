-- The requester tapped "Send design retainer": their next message in the
-- thread that is exactly an email address is where the QuickBooks invoice goes.
-- One pending retainer per thread; it lapses after a day (checked on read).
CREATE TABLE pending_retainers (
  platform    text NOT NULL,
  space_id    text NOT NULL,
  thread_id   text NOT NULL,
  run_id      text NOT NULL REFERENCES runs(id),
  person_id   text NOT NULL REFERENCES persons(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, space_id, thread_id)
);
