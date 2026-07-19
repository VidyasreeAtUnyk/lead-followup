-- Real estate lead follow-up: SQLite schema
-- All persistent state lives here. No in-memory session state is required for correctness.

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  property_interest TEXT,
  budget REAL,
  location_pref TEXT,
  timeline TEXT,
  source TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('prospect','client')) DEFAULT 'prospect',
  stage TEXT NOT NULL CHECK (stage IN (
    'new','contacted','qualified','viewing_scheduled','decision_pending',
    'won','lost','canceled','dormant'
  )) DEFAULT 'new',
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  last_contacted_at TEXT,
  contact_count INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  locked_by TEXT
);

CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  type TEXT NOT NULL CHECK (type IN ('page_view','email_open','reply','inquiry')),
  timestamp TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  type TEXT NOT NULL CHECK (type IN ('message','viewing')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
  rejection_reason TEXT,
  proposed_time TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','human'))
);

CREATE TABLE IF NOT EXISTS properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  area TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL NOT NULL,
  bedrooms INTEGER NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('standard','upgrade'))
);

CREATE TABLE IF NOT EXISTS property_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  year INTEGER NOT NULL,
  avg_price REAL NOT NULL
);

-- Tracks which lead the agent is currently mid-run on, purely so a restart can
-- resume the same run loop rather than re-picking a queue item. It stores no
-- conversation state -- the agent loop reconstructs everything else it needs
-- from leads/interactions/proposals/audit_log.
CREATE TABLE IF NOT EXISTS run_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_lead_id INTEGER,
  updated_at TEXT NOT NULL
);

-- One row per agent run, for lightweight observability (aggregate stats via
-- the `metrics` CLI command) -- not a replacement for the domain audit trail
-- in audit_log, which remains the source of truth for what actually happened.
CREATE TABLE IF NOT EXISTS run_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('escalated','proposal_created','sent','no_action')),
  tool_call_count INTEGER NOT NULL,
  estimated_token_cost REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactions_lead ON interactions(lead_id);
CREATE INDEX IF NOT EXISTS idx_proposals_lead ON proposals(lead_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_audit_lead ON audit_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_price_history_property ON property_price_history(property_id);
