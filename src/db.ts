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

-- Collecte OpenStreetMap par commune (tous les métiers en une requête).
-- fetched_at : dernière réussite ; failed_at : dernier échec (pour espacer les nouvelles tentatives).
CREATE TABLE IF NOT EXISTS osm_cities (
  city_code  TEXT PRIMARY KEY,
  city_name  TEXT NOT NULL,
  fetched_at TEXT,
  failed_at  TEXT,
  error      TEXT
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

-- Communes à collecter en tâche de fond (recherches par département, région ou rayon) :
-- traitées lentement pour respecter les quotas des sources publiques.
CREATE TABLE IF NOT EXISTS collect_queue (
  city_code    TEXT NOT NULL,
  city_name    TEXT NOT NULL,
  departement  TEXT NOT NULL,
  trade        TEXT NOT NULL,
  population   INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (city_code, trade)
);

-- Maquettes de sites : contenu éditable (JSON), servi sur /p/<id>. L'id (128 bits aléatoires)
-- est le secret du lien de partage. expires_at / revoked_at contrôlent l'accès public.
CREATE TABLE IF NOT EXISTS mockups (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Une opposition / demande de suppression de l'entreprise supprime aussi ses maquettes.
  prospect_id    TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  data           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  views          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mockups_user ON mockups (user_id, updated_at);

-- Journal des créations de maquettes (quota) : indépendant des suppressions.
CREATE TABLE IF NOT EXISTS mockup_events (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mockup_events ON mockup_events (user_id, created_at);

-- Crédits achetés (packs d'entreprises supplémentaires). source unique : un paiement = un ajout.
CREATE TABLE IF NOT EXISTS credits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER NOT NULL,
  source     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- Historique du suivi commercial (déblocage, statuts, maquettes, messages préparés…).
CREATE TABLE IF NOT EXISTS lead_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_lead_events ON lead_events (user_id, prospect_id, id);

-- Rédactions IA : quota par utilisateur et budget quotidien global (coût estimé en USD).
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage ON ai_usage (created_at, user_id);

-- Images envoyées par les utilisateurs (logo, photo des maquettes), fichiers dans UPLOAD_DIR.
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_user ON media (user_id, created_at);

-- Paramètres internes (versions de barème, etc.).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prospect_id TEXT NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, prospect_id)
);

-- Recherches distinctes par utilisateur et par jour (quota de recherches, maîtrise des coûts).
-- Relancer la même recherche le même jour (pagination, rafraîchissement) ne compte qu'une fois.
CREATE TABLE IF NOT EXISTS search_usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  key     TEXT NOT NULL,
  PRIMARY KEY (user_id, day, key)
);

-- Inscriptions par adresse IP (limitation des comptes gratuits créés en série). IP hachée.
CREATE TABLE IF NOT EXISTS signups (
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signups_ip ON signups (ip_hash, created_at);

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
  migrate(db);
  return db;
}

/**
 * Colonnes ajoutées après la création initiale des tables. `CREATE TABLE IF NOT EXISTS`
 * ne modifie pas une table existante : on ajoute les colonnes manquantes, sans jamais
 * supprimer ni réécrire de données.
 */
const COLUMNS: Record<string, [string, string][]> = {
  leads: [
    // Vérification du site faite par l'utilisateur sur ce prospect (propre à son compte).
    ['site_check', 'TEXT'], // 'verified_none' | 'site_found'
    ['site_check_url', 'TEXT'],
    ['check_status', 'TEXT'],
    ['check_score', 'INTEGER'],
    ['check_issues', 'TEXT'],
    ['checked_at', 'TEXT'],
    // Suivi commercial : montant du contrat déclaré par l'utilisateur, date du dernier changement de statut.
    ['deal_amount', 'REAL'],
    ['status_changed_at', 'TEXT'],
    // 1 si ce déblocage a été payé par un crédit acheté (pack) plutôt que par l'offre.
    ['credit_used', 'INTEGER NOT NULL DEFAULT 0'],
  ],
  users: [
    ['payment_failed_at', 'TEXT'],
    ['billing_interval', 'TEXT'],
  ],
};

function migrate(db: DatabaseSync): void {
  for (const [table, cols] of Object.entries(COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
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
