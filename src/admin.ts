// Administration : indicateurs, utilisateurs, crédits offerts, coûts IA, erreurs, sauvegardes,
// et export des données personnelles d'un utilisateur (RGPD, droit d'accès et de portabilité).

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './auth.ts';
import { effectivePlan, quotaFor, type UserRow } from './billing.ts';
import { nowIso, type DB } from './db.ts';

export const isAdmin = (u: Pick<UserRow, 'role'> | null | undefined): boolean => u?.role === 'admin';

// --- Compte administrateur ---------------------------------------------------------------

/**
 * Crée le compte administrateur (ou donne le rôle à un compte existant). Un nouveau compte reçoit
 * un mot de passe provisoire aléatoire, à remplacer depuis le Profil.
 */
export async function ensureAdmin(db: DB, email: string): Promise<{ created: boolean; password: string | null }> {
  const e = email.trim().toLowerCase();
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(e) as { id: number } | undefined;
  if (row) {
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(row.id);
    return { created: false, password: null };
  }
  const password = randomBytes(12).toString('base64url');
  db.prepare(`INSERT INTO users (email, pass_hash, created_at, role) VALUES (?, ?, ?, 'admin')`).run(e, await hashPassword(password), nowIso());
  return { created: true, password };
}

// --- Indicateurs -----------------------------------------------------------------------

export function overview(db: DB, now = new Date()) {
  const n = (sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number | null }).n ?? 0);
  const day = now.toISOString().slice(0, 10);
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const d7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const users = db.prepare('SELECT * FROM users').all() as unknown as UserRow[];
  const byPlan: Record<string, number> = {};
  let mrr = 0;
  for (const u of users) {
    const p = effectivePlan(u, now);
    byPlan[p.id] = (byPlan[p.id] ?? 0) + 1;
    // Revenu récurrent estimé d'après la grille (l'annuel compte pour 1/12 par mois). Montants réels : tableau de bord Stripe.
    if (p.monthly) mrr += u.billing_interval === 'year' ? p.yearlyEur / 12 : p.priceEur;
  }
  return {
    users: users.length,
    signups7d: n('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', d7),
    byPlan,
    pastDue: n(`SELECT COUNT(*) AS n FROM users WHERE plan_status = 'past_due'`),
    mrrEstimate: Math.round(mrr * 100) / 100,
    unlocks30d: n('SELECT COUNT(*) AS n FROM leads WHERE unlocked_at >= ?', d30),
    mockups30d: n('SELECT COUNT(*) AS n FROM mockup_events WHERE created_at >= ?', d30),
    aiToday: { calls: n('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?', day), usd: n('SELECT SUM(cost_usd) AS n FROM ai_usage WHERE created_at >= ?', day) },
    ai30d: { calls: n('SELECT COUNT(*) AS n FROM ai_usage WHERE created_at >= ?', d30), usd: n('SELECT SUM(cost_usd) AS n FROM ai_usage WHERE created_at >= ?', d30) },
    aiDailyBudgetUsd: Number(process.env.AI_DAILY_BUDGET_USD ?? 2) || 0,
    prospects: n('SELECT COUNT(*) AS n FROM prospects'),
    collectQueue: n('SELECT COUNT(*) AS n FROM collect_queue'),
    osmFailures: n('SELECT COUNT(*) AS n FROM osm_cities WHERE fetched_at IS NULL AND failed_at IS NOT NULL'),
    optouts: n('SELECT COUNT(*) AS n FROM optouts'),
    errors24h: n('SELECT COUNT(*) AS n FROM app_errors WHERE at >= ?', new Date(now.getTime() - 86_400_000).toISOString()),
    mediaBytes: n('SELECT SUM(size) AS n FROM media'),
  };
}

/** Consommation anormale : alertes affichées en tête de l'administration. */
export function alerts(o: ReturnType<typeof overview>): string[] {
  const out: string[] = [];
  if (o.aiDailyBudgetUsd && o.aiToday.usd >= o.aiDailyBudgetUsd * 0.8) out.push(`Dépense IA du jour à ${Math.round((o.aiToday.usd / o.aiDailyBudgetUsd) * 100)} % du plafond.`);
  if (o.errors24h >= 20) out.push(`${o.errors24h} erreurs techniques ces dernières 24 h.`);
  if (o.signups7d >= 200) out.push(`${o.signups7d} inscriptions en 7 jours : vérifier l'absence de création de comptes en série.`);
  if (o.collectQueue >= 2000) out.push(`File de collecte OpenStreetMap longue (${o.collectQueue} communes).`);
  if (o.pastDue) out.push(`${o.pastDue} abonnement${o.pastDue > 1 ? 's' : ''} en paiement échoué.`);
  return out;
}

export function listUsers(db: DB, q = '', limit = 100) {
  const like = `%${q.trim().toLowerCase().replace(/[%_]/g, '')}%`;
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM leads l WHERE l.user_id = u.id) AS leads,
         (SELECT COUNT(*) FROM mockups m WHERE m.user_id = u.id) AS mockups,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage a WHERE a.user_id = u.id) AS ai_usd
       FROM users u WHERE lower(u.email) LIKE ? ORDER BY u.created_at DESC LIMIT ?`,
    )
    .all(like, limit) as unknown as (UserRow & { leads: number; mockups: number; ai_usd: number })[];
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role ?? null,
    created_at: u.created_at,
    plan: effectivePlan(u).id,
    plan_status: u.plan_status,
    billing_interval: u.billing_interval ?? null,
    quota: quotaFor(db, u),
    leads: Number(u.leads),
    mockups: Number(u.mockups),
    aiUsd: Math.round(Number(u.ai_usd) * 1000) / 1000,
  }));
}

/** Crédits offerts par l'administration (geste commercial, compensation) : tracés comme tels. */
export function grantCredits(db: DB, userId: number, amount: number, adminId: number): boolean {
  if (!Number.isInteger(amount) || amount < 1 || amount > 10_000) return false;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return false;
  db.prepare('INSERT INTO credits (user_id, amount, source, created_at) VALUES (?, ?, ?, ?)').run(
    userId, amount, `admin:${adminId}:${randomBytes(6).toString('hex')}`, nowIso(),
  );
  return true;
}

export const recentErrors = (db: DB, limit = 50) =>
  db.prepare('SELECT at, route, message FROM app_errors ORDER BY id DESC LIMIT ?').all(limit) as { at: string; route: string; message: string }[];

export function logError(db: DB, route: string, err: unknown): void {
  try {
    db.prepare('INSERT INTO app_errors (at, route, message) VALUES (?, ?, ?)').run(nowIso(), route.slice(0, 200), String((err as Error)?.message ?? err).slice(0, 500));
    if (Math.random() < 0.02) db.prepare('DELETE FROM app_errors WHERE at < ?').run(new Date(Date.now() - 30 * 86_400_000).toISOString());
  } catch {
    /* la journalisation ne doit jamais faire échouer une requête */
  }
}

// --- Export RGPD ------------------------------------------------------------------------

/** Toutes les données d'un utilisateur, dans un format lisible et réutilisable (JSON). */
export function exportUserData(db: DB, userId: number) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as unknown as UserRow;
  const all = (sql: string) => db.prepare(sql).all(userId);
  return {
    exported_at: nowIso(),
    account: {
      email: u.email, created_at: u.created_at, full_name: u.full_name, agency_name: u.agency_name, phone: u.phone, website: u.website,
      plan: u.plan, plan_status: u.plan_status, billing_interval: u.billing_interval ?? null, period_end: u.period_end,
    },
    leads: all(`SELECT l.prospect_id, p.name, p.trade, p.city, p.phone, p.email, p.website, l.status, l.note, l.next_action_at, l.deal_amount,
      l.unlocked_at, l.site_check, l.site_check_url FROM leads l JOIN prospects p ON p.id = l.prospect_id WHERE l.user_id = ?`),
    history: all('SELECT prospect_id, at, kind, detail FROM lead_events WHERE user_id = ? ORDER BY id'),
    favorites: all('SELECT prospect_id, created_at FROM favorites WHERE user_id = ?'),
    mockups: all('SELECT id, prospect_id, data, created_at, updated_at, expires_at, revoked_at, views FROM mockups WHERE user_id = ?'),
    images: all('SELECT id, mime, size, created_at FROM media WHERE user_id = ?'),
    credits: all('SELECT amount, created_at FROM credits WHERE user_id = ?'),
    ai_usage: all('SELECT created_at, input_tokens, output_tokens, cost_usd FROM ai_usage WHERE user_id = ?'),
  };
}

// --- Sauvegardes ---------------------------------------------------------------------------

/**
 * Copie cohérente de la base (VACUUM INTO, possible pendant l'utilisation) dans BACKUP_DIR,
 * une par jour, les 14 plus récentes conservées. Les images (UPLOAD_DIR) sont à copier avec.
 */
export function backupDatabase(db: DB, dir = process.env.BACKUP_DIR || 'data/backups', keep = 14, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `sitolead-${now.toISOString().slice(0, 10)}.db`);
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(dir).filter((f) => /^sitolead-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}
