-- prism-control-plane 0007: single-use short-lived STT session tickets.
--
-- Browsers cannot set Authorization on WebSocket upgrades, so the only
-- standard place for a credential is Sec-WebSocket-Protocol. Putting the
-- long-lived client key (pcp_...) there leaves it in upgrade logs and
-- browser internals. Instead:
--
--   1. POST /v1/stt/sessions with Authorization: Bearer pcp_... mints a ticket
--   2. WebSocket opens with Sec-WebSocket-Protocol: prism.v1, stt_<secret>
--   3. The plane consumes the ticket once (conditional UPDATE) and never
--      accepts a pcp_ key in the protocol list
--
-- Same hash + single-use pattern as enrollments: a leaked tickets table is
-- not a set of usable credentials, and two concurrent consumes cannot both win.

CREATE TABLE IF NOT EXISTS stt_tickets (
  token_hash   TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  client_id    TEXT NOT NULL REFERENCES clients(id),
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Single-use is enforced by a conditional UPDATE on this column.
  consumed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_stt_tickets_client ON stt_tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_stt_tickets_expires ON stt_tickets(expires_at);
