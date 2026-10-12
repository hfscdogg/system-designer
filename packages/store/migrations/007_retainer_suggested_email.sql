-- "Send design retainer" offers the one email address the rep typed in the
-- original request ("Email: jane@example.com"); "yes" sends the invoice there.
-- Null when the request had none, or more than one.
ALTER TABLE pending_retainers ADD COLUMN suggested_email text;
