-- Leads: the core record. Text columns hold exactly what the customer typed.
CREATE TABLE leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL DEFAULT '',
  service       TEXT NOT NULL CHECK (service IN ('cleaning', 'repair', 'consultation', 'other')),
  message       TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('booking', 'question', 'complaint', 'other')),
  urgency       TEXT NOT NULL CHECK (urgency IN ('high', 'normal', 'low')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'won', 'lost')),
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  -- Internal: which sorter decided. Never part of the public lead JSON.
  sorted_by     TEXT NOT NULL DEFAULT 'rules' CHECK (sorted_by IN ('ai', 'rules'))
);

CREATE INDEX idx_leads_status ON leads (status, id DESC);
CREATE INDEX idx_leads_category ON leads (category, id DESC);

-- Webhook outbox: written in the same transaction as the lead, so a failed
-- delivery can be retried later instead of being lost.
CREATE TABLE webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id         INTEGER NOT NULL UNIQUE REFERENCES leads (id),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL
);

CREATE INDEX idx_webhook_due ON webhook_deliveries (status, next_attempt_at);

-- Failed owner logins, used to slow down password guessing.
CREATE TABLE login_failures (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ip        TEXT NOT NULL,
  failed_at TEXT NOT NULL
);

CREATE INDEX idx_login_failures_ip ON login_failures (ip, failed_at);
