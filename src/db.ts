import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  email                  TEXT NOT NULL UNIQUE,
  pass_hash              TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  plan                   TEXT NOT NULL DEFAULT 'free',
  plan_status            TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  period_end             TEXT,
  full_name              TEXT,
  agency_name            TEXT,
  phone                  TEXT,
  website                TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prospects (
  id            TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  siret         TEXT,
  name          TEXT NOT NULL,
  trade         TEXT NOT NULL,
  address       TEXT,
  postal_code   TEXT,
  city          TEXT,
  city_code     TEXT NOT NULL,
  lat           REAL,
  lon           REAL,
  phone         TEXT,
  email         TEXT,
  website       TEXT,
  created_on    TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  site_status   TEXT NOT NULL,
  audit_score   INTEGER,
  audit_issues  TEXT,
  audited_at    TEXT,
  opportunity   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prospects_city_trade ON prospects (city_code, trade, opportunity DESC);
CREATE INDEX IF NOT EXISTS idx_prospects_siret ON prospects (siret);
CREATE INDEX IF NOT EXISTS idx_prospects_audit ON prospects (site_status);

CREATE TABLE IF NOT EXISTS searches (
  key        TEXT PRIMARY KEY,
  city_code  TEXT NOT NULL,
  city_name  TEXT NOT NULL,
  trade      TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  found      INTEGER NOT NULL,
  errors     TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prospect_id    TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  unlocked_at    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'a_contacter',
  note           TEXT NOT NULL DEFAULT '',
  next_action_at TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, prospect_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_user_unlocked ON leads (user_id, unlocked_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- Entreprises à ne jamais proposer : opposition à la prospection inscrite au registre
-- SIRENE, ou demande de suppression reçue. Clés : id:, siret:, siren:, email:, phone:
CREATE TABLE IF NOT EXISTS optouts (
  key        TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path = process.env.DB_PATH ?? 'data/sitolead.db'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export const nowIso = () => new Date().toISOString();

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
