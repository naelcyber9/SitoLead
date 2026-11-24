// Suivi commercial : historique des actions sur chaque prospect et statistiques réelles.
// Les statistiques ne comptent que ce que SitoLead peut constater (déblocages, maquettes,
// visites, messages préparés, statuts choisis par l'utilisateur, chiffre d'affaires qu'il
// déclare) : rien n'est estimé ni présenté comme une vente qui n'a pas été saisie.

import { nowIso, tx, type DB } from './db.ts';

export const LEAD_STATUSES = ['debloque', 'maquette', 'contacte', 'relance', 'reponse', 'negociation', 'gagne', 'perdu', 'stop'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const STATUS_LABELS: Record<LeadStatus, string> = {
  debloque: 'Lead débloqué',
  maquette: 'Maquette générée',
  contacte: 'Contacté',
  relance: 'Relance prévue',
  reponse: 'Réponse reçue',
  negociation: 'En négociation',
  gagne: 'Client gagné',
  perdu: 'Client perdu',
  stop: 'Ne plus contacter',
};

/** Statuts « clos » : pas de rappel, pas de relance. */
export const CLOSED: LeadStatus[] = ['gagne', 'perdu', 'stop'];
const CONTACTED: LeadStatus[] = ['contacte', 'relance', 'reponse', 'negociation', 'gagne', 'perdu'];
const REPLIED: LeadStatus[] = ['reponse', 'negociation', 'gagne'];

export type EventKind = 'unlock' | 'status' | 'note' | 'mockup' | 'message' | 'site_check' | 'amount';

export function logEvent(db: DB, userId: number, prospectId: string, kind: EventKind, detail = ''): void {
  db.prepare('INSERT INTO lead_events (user_id, prospect_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)').run(userId, prospectId, nowIso(), kind, detail.slice(0, 300));
}

export const listEvents = (db: DB, userId: number, prospectId: string) =>
  db.prepare('SELECT at, kind, detail FROM lead_events WHERE user_id = ? AND prospect_id = ? ORDER BY id DESC LIMIT 100').all(userId, prospectId) as {
    at: string;
    kind: EventKind;
    detail: string;
  }[];

/** Passe un lead au statut donné seulement s'il est encore à une étape antérieure (jamais de retour en arrière automatique). */
export function advanceStatus(db: DB, userId: number, prospectId: string, from: LeadStatus[], to: LeadStatus): boolean {
  const r = db
    .prepare(`UPDATE leads SET status = ?, status_changed_at = ?, updated_at = ? WHERE user_id = ? AND prospect_id = ? AND status IN (${from.map(() => '?').join(',')})`)
    .run(to, nowIso(), nowIso(), userId, prospectId, ...from);
  if (Number(r.changes) > 0) logEvent(db, userId, prospectId, 'status', to);
  return Number(r.changes) > 0;
}

export interface Stats {
  unlocked: number;
  unlocked30d: number;
  mockups: number;
  mockupViews: number;
  messagesPrepared: number;
  contacted: number;
  replies: number;
  won: number;
  lost: number;
  /** Clients gagnés / prospects contactés (null si personne n'a encore été contacté). */
  conversionRate: number | null;
  /** Chiffre d'affaires déclaré par l'utilisateur sur ses clients gagnés. */
  revenue: number;
  dueToday: number;
  byStatus: Record<LeadStatus, number>;
}

export function userStats(db: DB, userId: number, now = new Date()): Stats {
  const n = (sql: string, ...args: (string | number)[]) => Number((db.prepare(sql).get(userId, ...args) as { n: number | null }).n ?? 0);
  const in_ = (list: LeadStatus[]) => `(${list.map((s) => `'${s}'`).join(',')})`;
  const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM leads WHERE user_id = ? GROUP BY status').all(userId) as { status: LeadStatus; n: number }[]) {
    if (r.status in byStatus) byStatus[r.status] = Number(r.n);
  }
  const contacted = n(`SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND status IN ${in_(CONTACTED)}`);
  const won = byStatus.gagne;
  const day = now.toISOString().slice(0, 10);
  return {
    unlocked: n('SELECT COUNT(*) AS n FROM leads WHERE user_id = ?'),
    unlocked30d: n('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND unlocked_at >= ?', new Date(now.getTime() - 30 * 86_400_000).toISOString()),
    mockups: n('SELECT COUNT(*) AS n FROM mockups WHERE user_id = ?'),
    mockupViews: n('SELECT SUM(views) AS n FROM mockups WHERE user_id = ?'),
    messagesPrepared: n(`SELECT COUNT(*) AS n FROM lead_events WHERE user_id = ? AND kind = 'message'`),
    contacted,
    replies: n(`SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND status IN ${in_(REPLIED)}`),
    won,
    lost: byStatus.perdu,
    conversionRate: contacted ? won / contacted : null,
    revenue: n(`SELECT SUM(deal_amount) AS n FROM leads WHERE user_id = ? AND status = 'gagne'`),
    dueToday: n(`SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND next_action_at IS NOT NULL AND next_action_at <= ? AND status NOT IN ${in_(CLOSED)}`, day),
    byStatus,
  };
}

/** Conversion des anciens statuts (a_contacter, rdv, devis) vers la nouvelle liste, une seule fois. */
export function migrateStatuses(db: DB): number {
  const cur = db.prepare(`SELECT value FROM meta WHERE key = 'crm_version'`).get() as { value: string } | undefined;
  if (cur?.value === '1') return 0;
  return tx(db, () => {
    const a = Number(db.prepare(`UPDATE leads SET status = 'debloque' WHERE status = 'a_contacter'`).run().changes);
    const b = Number(db.prepare(`UPDATE leads SET status = 'negociation' WHERE status IN ('rdv', 'devis')`).run().changes);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('crm_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
    return a + b;
  });
}
