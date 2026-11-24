// Prospects : collecte (sources + cache), audit en tâche de fond, recherche,
// déblocage soumis au quota et pipeline commercial.

import { auditWebsite, classifyWebsite, type AuditIssue, type SiteStatus } from './audit.ts';
import { quotaFor, type UserRow } from './billing.ts';
import { CITIES, TRADES, tradeBySlug } from './catalog.ts';
import { nowIso, tx, type DB } from './db.ts';
import { NO_SITE_STATUSES, opportunityDetails, opportunityScore, statusLabel, type ScoreFactor } from './scoring.ts';
import { fetchOsmCity, fetchSirene, type Commune, type RawProspect } from './sources.ts';
import { dequeue, nextQueued } from './zones.ts';

export interface ProspectRow {
  id: string;
  source: string;
  siret: string | null;
  name: string;
  trade: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  city_code: string;
  lat: number | null;
  lon: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  created_on: string | null;
  first_seen_at: string;
  updated_at: string;
  site_status: SiteStatus;
  audit_score: number | null;
  audit_issues: string | null;
  audited_at: string | null;
  opportunity: number;
}

export const parseIssues = (s: string | null): AuditIssue[] => {
  try {
    return s ? (JSON.parse(s) as AuditIssue[]) : [];
  } catch {
    return [];
  }
};

const AUDIT_TTL_MS = 30 * 86_400_000;
const SEARCH_TTL_MS = 7 * 86_400_000;

function initialStatus(raw: RawProspect): SiteStatus {
  const kind = classifyWebsite(raw.website);
  if (kind === 'social') return 'social';
  if (kind === 'site') return 'pending';
  return raw.source === 'sirene' ? 'unknown' : 'none';
}

// --- Oppositions et demandes de suppression ---------------------------------------------

/** Numéro français normalisé sur 10 chiffres (0XXXXXXXXX), ou '' si ce n'en est pas un. */
export function normPhone(s: string): string {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('0033')) d = d.slice(4);
  else if (d.startsWith('33') && d.length === 11) d = d.slice(2);
  if (d.length === 9) d = `0${d}`;
  return /^0\d{9}$/.test(d) ? d : '';
}

export function optOutKeysFor(p: { id: string; siret: string | null; email: string | null; phone: string | null }): string[] {
  const keys = [`id:${p.id}`];
  if (p.siret && /^\d{14}$/.test(p.siret)) keys.push(`siret:${p.siret}`, `siren:${p.siret.slice(0, 9)}`);
  if (p.email) keys.push(`email:${p.email.trim().toLowerCase()}`);
  const phone = p.phone ? normPhone(p.phone) : '';
  if (phone) keys.push(`phone:${phone}`);
  return keys;
}

/** Saisie libre (SIRET, SIREN, email, téléphone, identifiant de fiche) → clé d'opposition. */
export function optOutKey(input: string): string | null {
  const v = input.trim();
  if (/^(id|siret|siren|email|phone):\S+$/.test(v)) return v;
  if (/^(osm|sirene):\S+$/.test(v)) return `id:${v}`;
  if (v.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? `email:${v.toLowerCase()}` : null;
  const digits = v.replace(/[\s.]/g, '');
  if (/^\d{14}$/.test(digits)) return `siret:${digits}`;
  if (/^\d{9}$/.test(digits)) return `siren:${digits}`;
  const phone = normPhone(v);
  return phone ? `phone:${phone}` : null;
}

/**
 * Enregistre des oppositions et supprime aussitôt les fiches concernées (les déblocages
 * associés partent avec, par cascade). Renvoie le nombre de fiches supprimées.
 */
export function addOptOuts(db: DB, keys: string[], reason: string): number {
  const unique = [...new Set(keys)];
  if (!unique.length) return 0;
  const now = nowIso();
  const ins = db.prepare('INSERT OR IGNORE INTO optouts (key, reason, created_at) VALUES (?, ?, ?)');
  const delId = db.prepare('DELETE FROM prospects WHERE id = ?');
  const delSiret = db.prepare('DELETE FROM prospects WHERE siret = ?');
  const delSiren = db.prepare('DELETE FROM prospects WHERE siret BETWEEN ? AND ?');
  const delEmail = db.prepare('DELETE FROM prospects WHERE lower(email) = ?');
  return tx(db, () => {
    let removed = 0;
    for (const key of unique) {
      ins.run(key, reason, now);
      const i = key.indexOf(':');
      const kind = key.slice(0, i);
      const value = key.slice(i + 1);
      if (kind === 'id') removed += Number(delId.run(value).changes);
      else if (kind === 'siret') removed += Number(delSiret.run(value).changes);
      else if (kind === 'siren') removed += Number(delSiren.run(`${value}00000`, `${value}99999`).changes);
      else if (kind === 'email') removed += Number(delEmail.run(value).changes);
      else if (kind === 'phone') {
        const rows = db.prepare('SELECT id, phone FROM prospects WHERE phone IS NOT NULL').all() as { id: string; phone: string }[];
        for (const r of rows) if (normPhone(r.phone) === value) removed += Number(delId.run(r.id).changes);
      }
    }
    return removed;
  });
}

/** Insère ou met à jour les prospects ; un même SIRET n'est stocké qu'une fois. Les oppositions sont écartées. */
export function upsertProspects(db: DB, raws: RawProspect[], trade: string, cityCode: string): number {
  const blocked = new Set((db.prepare('SELECT key FROM optouts').all() as { key: string }[]).map((r) => r.key));
  const byId = db.prepare('SELECT * FROM prospects WHERE id = ?');
  const bySiret = db.prepare('SELECT * FROM prospects WHERE siret = ? LIMIT 1');
  const insert = db.prepare(
    `INSERT INTO prospects (id, source, siret, name, trade, address, postal_code, city, city_code, lat, lon, phone, email, website,
       created_on, first_seen_at, updated_at, site_status, opportunity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE prospects SET siret = COALESCE(?, siret), address = COALESCE(?, address), postal_code = COALESCE(?, postal_code),
       lat = COALESCE(?, lat), lon = COALESCE(?, lon), phone = COALESCE(?, phone), email = COALESCE(?, email),
       website = ?, created_on = COALESCE(created_on, ?), updated_at = ?, site_status = ?, audit_score = ?, audit_issues = ?,
       audited_at = ?, opportunity = ? WHERE id = ?`,
  );
  let n = 0;
  const now = nowIso();
  tx(db, () => {
    for (const raw of raws) {
      if (optOutKeysFor(raw).some((k) => blocked.has(k))) continue;
      const existing = (byId.get(raw.id) ?? (raw.siret ? bySiret.get(raw.siret) : undefined)) as ProspectRow | undefined;
      if (!existing) {
        const status = initialStatus(raw);
        const opp = opportunityScore({ site_status: status, audit_score: null, phone: raw.phone, email: raw.email, created_on: raw.created_on });
        insert.run(raw.id, raw.source, raw.siret, raw.name, trade, raw.address, raw.postal_code, raw.city, cityCode, raw.lat, raw.lon,
          raw.phone, raw.email, raw.website, raw.created_on, now, now, status, opp);
        n++;
        continue;
      }
      // Une source SIRENE (sans site connu) ne doit pas écraser le site trouvé sur OpenStreetMap.
      const website = raw.website ?? existing.website;
      let status = existing.site_status;
      let score = existing.audit_score;
      let issues = existing.audit_issues;
      let audited = existing.audited_at;
      if (website !== existing.website || (status === 'unknown' && raw.source !== 'sirene')) {
        status = initialStatus({ ...raw, website });
        score = null;
        issues = null;
        audited = null;
      }
      const opp = opportunityScore({
        site_status: status,
        audit_score: score,
        phone: raw.phone ?? existing.phone,
        email: raw.email ?? existing.email,
        created_on: existing.created_on ?? raw.created_on,
      });
      update.run(raw.siret, raw.address, raw.postal_code, raw.lat, raw.lon, raw.phone, raw.email, website, raw.created_on, now,
        status, score, issues, audited, opp, existing.id);
      n++;
    }
  });
  return n;
}

// --- Collecte avec cache ---------------------------------------------------------

export interface SearchInfo {
  fetched_at: string | null;
  found: number;
  errors: string[];
  fresh: boolean;
  /** Collecte encore en cours : les résultats affichés sont partiels. */
  pending?: boolean;
}

const inflight = new Map<string, Promise<SearchInfo>>();

/** Vrai tant qu'une collecte est en cours pour cette commune et ce métier. */
export const isSearching = (cityCode: string, trade: string): boolean => inflight.has(`${cityCode}|${trade}`);

export function searchInfo(db: DB, cityCode: string, trade: string): SearchInfo | null {
  const r = db.prepare('SELECT * FROM searches WHERE key = ?').get(`${cityCode}|${trade}`) as
    | { fetched_at: string; found: number; errors: string | null }
    | undefined;
  if (!r) return null;
  return { fetched_at: r.fetched_at, found: r.found, errors: r.errors ? (JSON.parse(r.errors) as string[]) : [], fresh: Date.now() - Date.parse(r.fetched_at) < SEARCH_TTL_MS };
}

export async function refreshSearch(
  db: DB,
  commune: Commune,
  tradeSlug: string,
  opts: { live: boolean; force?: boolean; background?: boolean } = { live: true },
): Promise<SearchInfo> {
  const trade = tradeBySlug(tradeSlug);
  if (!trade) throw new Error('Métier inconnu');
  const key = `${commune.code}|${trade.slug}`;
  const cached = searchInfo(db, commune.code, trade.slug);
  if (!opts.live || (cached?.fresh && !cached.errors.length && !opts.force)) return cached ?? { fetched_at: null, found: 0, errors: [], fresh: false };
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    // Chaque source est enregistrée dès qu'elle répond : SIRENE (rapide) n'attend pas
    // OpenStreetMap (souvent lent), et l'écran peut afficher les premiers résultats.
    // L'ordre n'importe pas : upsertProspects fusionne les fiches par SIRET dans les deux sens,
    // et addOptOuts supprime aussi les fiches déjà enregistrées.
    const errors: string[] = [];
    const osm = osmStatus(db, commune.code);
    await Promise.all([
      fetchSirene(commune, trade, { background: opts.background }).then(
        (r) => {
          // Les entreprises opposées à la prospection sont écartées, y compris leurs fiches OpenStreetMap.
          addOptOuts(db, r.optOuts.map((s) => `siren:${s}`), 'Opposition à la prospection commerciale (registre SIRENE)');
          upsertProspects(db, r.prospects, trade.slug, commune.code);
          scheduleAudits(db);
        },
        (e: Error) => errors.push(e.message),
      ),
      // OpenStreetMap est collecté par commune, tous métiers confondus : si la commune a déjà
      // été chargée (préchargement ou recherche d'un autre métier), il n'y a rien à attendre.
      osm.fresh
        ? null
        : osm.retryLater
          ? errors.push(osm.error ?? 'OpenStreetMap indisponible')
          : refreshCityOsm(db, commune).catch((e: Error) => errors.push(e.message)),
    ]);
    const found = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM prospects WHERE city_code = ? AND trade = ?').get(commune.code, trade.slug) as { n: number }).n,
    );
    const fetched = nowIso();
    db.prepare(
      `INSERT INTO searches (key, city_code, city_name, trade, fetched_at, found, errors) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET fetched_at = excluded.fetched_at, found = excluded.found, errors = excluded.errors, city_name = excluded.city_name`,
    ).run(key, commune.code, commune.nom, trade.slug, fetched, found, errors.length ? JSON.stringify(errors) : null);
    return { fetched_at: fetched, found, errors, fresh: true };
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Une recherche incomplète (une source a échoué) est retentée, mais pas plus d'une fois toutes les quelques minutes. */
export const RETRY_MS = 5 * 60_000;
export const shouldRetry = (info: SearchInfo): boolean =>
  info.errors.length > 0 && info.fetched_at !== null && Date.now() - Date.parse(info.fetched_at) > RETRY_MS;

// --- OpenStreetMap par commune ------------------------------------------------------

export function osmStatus(db: DB, cityCode: string): { fresh: boolean; retryLater: boolean; error: string | null } {
  const r = db.prepare('SELECT fetched_at, failed_at, error FROM osm_cities WHERE city_code = ?').get(cityCode) as
    | { fetched_at: string | null; failed_at: string | null; error: string | null }
    | undefined;
  const age = (iso: string | null | undefined) => (iso ? Date.now() - Date.parse(iso) : Infinity);
  const fresh = age(r?.fetched_at) < SEARCH_TTL_MS;
  // Après un échec, on attend avant de réinterroger des serveurs déjà saturés.
  const retryLater = !fresh && age(r?.failed_at) < RETRY_MS && age(r?.failed_at) < age(r?.fetched_at);
  return { fresh, retryLater, error: r?.error ?? null };
}

const osmInflight = new Map<string, Promise<void>>();

/** Charge tous les métiers d'une commune depuis OpenStreetMap (une seule requête, partagée entre recherches simultanées). */
export function refreshCityOsm(db: DB, commune: Commune, fetchCity = fetchOsmCity): Promise<void> {
  const running = osmInflight.get(commune.code);
  if (running) return running;
  const job = (async () => {
    try {
      const byTrade = await fetchCity(commune, TRADES);
      for (const [trade, raws] of byTrade) upsertProspects(db, raws, trade, commune.code);
      db.prepare(
        `INSERT INTO osm_cities (city_code, city_name, fetched_at, failed_at, error) VALUES (?, ?, ?, NULL, NULL)
         ON CONFLICT(city_code) DO UPDATE SET city_name = excluded.city_name, fetched_at = excluded.fetched_at, failed_at = NULL, error = NULL`,
      ).run(commune.code, commune.nom, nowIso());
      scheduleAudits(db);
    } catch (e) {
      db.prepare(
        `INSERT INTO osm_cities (city_code, city_name, fetched_at, failed_at, error) VALUES (?, ?, NULL, ?, ?)
         ON CONFLICT(city_code) DO UPDATE SET city_name = excluded.city_name, failed_at = excluded.failed_at, error = excluded.error`,
      ).run(commune.code, commune.nom, nowIso(), (e as Error).message);
      throw e;
    }
  })().finally(() => osmInflight.delete(commune.code));
  osmInflight.set(commune.code, job);
  return job;
}

// --- Préchargement ---------------------------------------------------------------

let warming = false;

/**
 * Précharge les grandes villes (pages SEO) pour tous les métiers, en tâche de fond, afin que
 * les recherches les plus courantes soient instantanées. Ce qui est à jour est sauté, ce qui a
 * échoué est retenté plus tard. Cède la place dès qu'un utilisateur lance une recherche.
 */
export async function warmCache(db: DB, opts: { pauseMs?: number; cities?: typeof CITIES; queuePerRun?: number } = {}): Promise<void> {
  if (warming) return;
  warming = true;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    // 1. Communes demandées par des recherches de zone (département, région, rayon), en premier
    //    car un utilisateur les attend ; limitées par passage pour ménager les sources publiques.
    for (const q of nextQueued(db, opts.queuePerRun ?? 25)) {
      while (inflight.size > 0) await pause(500);
      const commune: Commune = { code: q.city_code, nom: q.city_name, departement: q.departement, population: 0, codesPostaux: [] };
      await refreshSearch(db, commune, q.trade, { live: true, force: true, background: true }).catch(() => {});
      dequeue(db, q.city_code, q.trade);
      await pause(opts.pauseMs ?? 1000);
    }
    // 2. Grandes villes (pages SEO), tous métiers.
    for (const city of opts.cities ?? CITIES) {
      const commune: Commune = { code: city.code, nom: city.name, departement: city.dep, population: 0, codesPostaux: [] };
      for (const t of TRADES) {
        const info = searchInfo(db, city.code, t.slug);
        if (info?.fresh && !shouldRetry(info)) continue;
        while (inflight.size > 0) await pause(500); // priorité aux recherches des utilisateurs
        await refreshSearch(db, commune, t.slug, { live: true, force: true, background: true }).catch(() => {});
        await pause(opts.pauseMs ?? 1000);
      }
    }
  } finally {
    warming = false;
  }
}

// --- Audits en tâche de fond --------------------------------------------------------

let auditsRunning = 0;
const AUDIT_CONCURRENCY = 3;
const auditing = new Set<string>();

export function applyAudit(db: DB, id: string, result: { status: SiteStatus; score: number | null; issues: AuditIssue[] }): void {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(id) as ProspectRow | undefined;
  if (!p) return;
  const opp = opportunityScore({ site_status: result.status, audit_score: result.score, phone: p.phone, email: p.email, created_on: p.created_on });
  db.prepare('UPDATE prospects SET site_status = ?, audit_score = ?, audit_issues = ?, audited_at = ?, opportunity = ? WHERE id = ?').run(
    result.status, result.score, JSON.stringify(result.issues), nowIso(), opp, id,
  );
}

export function scheduleAudits(db: DB, audit = auditWebsite): void {
  while (auditsRunning < AUDIT_CONCURRENCY) {
    const stale = new Date(Date.now() - AUDIT_TTL_MS).toISOString();
    const exclude = [...auditing];
    const next = db
      .prepare(
        `SELECT id, website FROM prospects WHERE website IS NOT NULL AND site_status NOT IN ('social')
         AND (site_status = 'pending' OR audited_at < ?) ${exclude.length ? `AND id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
         ORDER BY site_status = 'pending' DESC, first_seen_at DESC LIMIT 1`,
      )
      .get(stale, ...exclude) as { id: string; website: string } | undefined;
    if (!next) return;
    auditsRunning++;
    auditing.add(next.id);
    audit(next.website)
      .then((r) => applyAudit(db, next.id, r))
      .catch(() => applyAudit(db, next.id, { status: 'unknown', score: null, issues: [] }))
      .finally(() => {
        auditsRunning--;
        auditing.delete(next.id);
        scheduleAudits(db, audit);
      });
  }
}

// --- Recherche ----------------------------------------------------------------------

export interface ListFilters {
  /** Une commune, ou plusieurs pour une recherche par rayon. */
  cityCode?: string | string[];
  /** Préfixes de code INSEE : départements (« 74 », « 2A », « 971 ») pour une recherche par département ou région. */
  cityPrefixes?: string[];
  trade?: string;
  status?: 'all' | 'nosite' | 'weak' | 'recent';
  minScore?: number;
  /** Coordonnées disponibles : téléphone, email, ou l'un des deux. */
  contact?: 'phone' | 'email' | 'any';
  favoritesOnly?: boolean;
  source?: 'osm' | 'sirene';
  limit?: number;
  offset?: number;
}

export const SQL_NO_SITE = `(${NO_SITE_STATUSES.map((s) => `'${s}'`).join(',')})`;

export function mask(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w.length <= 1 ? w : w[0] + '•'.repeat(Math.min(w.length - 1, 8))))
    .join(' ');
}

export interface PublicProspect {
  id: string;
  unlocked: boolean;
  name: string;
  trade: string;
  tradeLabel: string;
  city: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  siret: string | null;
  /** Position exacte si débloquée ; sinon arrondie à ~1 km (carte), pour ne pas révéler l'adresse. */
  lat: number | null;
  lon: number | null;
  approxPosition: boolean;
  hasPhone: boolean;
  hasEmail: boolean;
  created_on: string | null;
  site_status: SiteStatus;
  statusLabel: string;
  audit_score: number | null;
  issues: AuditIssue[];
  opportunity: number;
  /** Explication du score : chaque critère et ses points. */
  scoreFactors: ScoreFactor[];
  source: string;
  sourceLabel: string;
  /** Date de récupération / mise à jour des informations depuis la source. */
  updated_at: string;
  favorite?: boolean;
  lead?: {
    status: string;
    note: string;
    next_action_at: string | null;
    unlocked_at: string;
    updated_at: string;
    /** Vérification du site faite par l'utilisateur, propre à son compte. */
    site_check: string | null;
    site_check_url: string | null;
    checked_at: string | null;
  };
}

const SOURCE_LABELS: Record<string, string> = {
  osm: 'OpenStreetMap',
  sirene: 'Annuaire des entreprises (SIRENE)',
  demo: 'Données de démonstration',
};

const approx = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

export function toPublic(p: ProspectRow, unlocked: boolean, lead?: PublicProspect['lead']): PublicProspect {
  const details = opportunityDetails(p);
  return {
    id: p.id,
    unlocked,
    name: unlocked ? p.name : mask(p.name),
    trade: p.trade,
    tradeLabel: tradeBySlug(p.trade)?.label ?? p.trade,
    city: p.city,
    postal_code: p.postal_code,
    address: unlocked ? p.address : null,
    phone: unlocked ? p.phone : null,
    email: unlocked ? p.email : null,
    website: unlocked ? p.website : null,
    siret: unlocked ? p.siret : null,
    lat: unlocked ? p.lat : approx(p.lat),
    lon: unlocked ? p.lon : approx(p.lon),
    approxPosition: !unlocked,
    hasPhone: Boolean(p.phone),
    hasEmail: Boolean(p.email),
    created_on: p.created_on,
    site_status: p.site_status,
    statusLabel: statusLabel(p.site_status),
    audit_score: p.audit_score,
    issues: parseIssues(p.audit_issues),
    opportunity: details.score,
    scoreFactors: details.factors,
    source: p.source,
    sourceLabel: SOURCE_LABELS[p.source] ?? p.source,
    updated_at: p.updated_at,
    lead,
  };
}

/**
 * Fiche d'un prospect débloqué : la vérification faite par l'utilisateur (aucun site trouvé,
 * ou site trouvé et audité) prime sur les données de la source, pour lui seulement.
 */
function withSiteCheck(p: ProspectRow, r: LeadJoin): ProspectRow {
  if (r.site_check === 'verified_none') return { ...p, site_status: 'verified_none', audit_score: null, audit_issues: null };
  if (r.site_check === 'site_found' && r.check_status) {
    return { ...p, website: r.site_check_url, site_status: r.check_status as SiteStatus, audit_score: r.check_score, audit_issues: r.check_issues };
  }
  return p;
}

export function listProspects(db: DB, userId: number | null, f: ListFilters): { total: number; items: PublicProspect[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.cityPrefixes?.length) {
    const prefixes = f.cityPrefixes.filter((p) => /^(\d{2,3}|2[AB])$/i.test(p)).slice(0, 30);
    if (!prefixes.length) return { total: 0, items: [] };
    where.push(`(${prefixes.map(() => 'p.city_code LIKE ?').join(' OR ')})`);
    args.push(...prefixes.map((p) => `${p.toUpperCase()}%`));
  } else {
    const codes = (Array.isArray(f.cityCode) ? f.cityCode : f.cityCode ? [f.cityCode] : []).slice(0, 2000);
    if (!codes.length) return { total: 0, items: [] };
    where.push(`p.city_code IN (${codes.map(() => '?').join(',')})`);
    args.push(...codes);
  }
  if (f.trade) {
    where.push('p.trade = ?');
    args.push(f.trade);
  }
  if (f.contact === 'phone') where.push('p.phone IS NOT NULL');
  else if (f.contact === 'email') where.push('p.email IS NOT NULL');
  else if (f.contact === 'any') where.push('(p.phone IS NOT NULL OR p.email IS NOT NULL)');
  if (f.source) {
    where.push('p.source = ?');
    args.push(f.source);
  }
  if (f.favoritesOnly) {
    where.push('p.id IN (SELECT prospect_id FROM favorites WHERE user_id = ?)');
    args.push(userId ?? -1);
  }
  if (f.status === 'nosite') where.push(`p.site_status IN ${SQL_NO_SITE}`);
  else if (f.status === 'weak') where.push(`p.site_status IN ('weak','down')`);
  else if (f.status === 'recent') {
    where.push('p.created_on >= ?');
    const d = new Date();
    d.setMonth(d.getMonth() - 18);
    args.push(d.toISOString().slice(0, 10));
  }
  if (f.minScore) {
    where.push('p.opportunity >= ?');
    args.push(f.minScore);
  }
  const w = where.join(' AND ');
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM prospects p WHERE ${w}`).get(...args) as { n: number }).n);
  const rows = db
    .prepare(
      `SELECT p.*, l.user_id AS l_user, f.user_id AS f_user FROM prospects p
       LEFT JOIN leads l ON l.prospect_id = p.id AND l.user_id = ?
       LEFT JOIN favorites f ON f.prospect_id = p.id AND f.user_id = ?
       WHERE ${w} ORDER BY p.opportunity DESC, p.name LIMIT ? OFFSET ?`,
    )
    .all(userId ?? -1, userId ?? -1, ...args, Math.min(f.limit ?? 50, 200), f.offset ?? 0) as unknown as (ProspectRow & {
    l_user: number | null;
    f_user: number | null;
  })[];
  return { total, items: rows.map((r) => ({ ...toPublic(r, r.l_user !== null), favorite: r.f_user !== null })) };
}

// --- Favoris ------------------------------------------------------------------------

export function setFavorite(db: DB, userId: number, prospectId: string, on: boolean): boolean {
  if (!db.prepare('SELECT 1 FROM prospects WHERE id = ?').get(prospectId)) return false;
  if (on) db.prepare('INSERT OR IGNORE INTO favorites (user_id, prospect_id, created_at) VALUES (?, ?, ?)').run(userId, prospectId, nowIso());
  else db.prepare('DELETE FROM favorites WHERE user_id = ? AND prospect_id = ?').run(userId, prospectId);
  return true;
}

// --- Déblocage et pipeline -----------------------------------------------------------

export type UnlockResult = { ok: true; prospect: PublicProspect; already: boolean } | { ok: false; reason: 'quota' | 'not_found' };

export function unlockProspect(db: DB, user: UserRow, prospectId: string): UnlockResult {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId) as ProspectRow | undefined;
    if (!p) return { ok: false, reason: 'not_found' } as const;
    const existing = db.prepare('SELECT 1 FROM leads WHERE user_id = ? AND prospect_id = ?').get(user.id, prospectId);
    if (!existing) {
      if (quotaFor(db, user).remaining <= 0) return { ok: false, reason: 'quota' } as const;
      const now = nowIso();
      db.prepare('INSERT INTO leads (user_id, prospect_id, unlocked_at, updated_at) VALUES (?, ?, ?, ?)').run(user.id, prospectId, now, now);
    }
    return { ok: true, prospect: getLead(db, user.id, prospectId)!, already: Boolean(existing) } as const;
  });
}

export const LEAD_STATUSES = ['a_contacter', 'contacte', 'relance', 'rdv', 'devis', 'gagne', 'perdu'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

type LeadJoin = ProspectRow & {
  status: string;
  note: string;
  next_action_at: string | null;
  unlocked_at: string;
  l_updated: string;
  site_check: string | null;
  site_check_url: string | null;
  check_status: string | null;
  check_score: number | null;
  check_issues: string | null;
  checked_at: string | null;
};

const LEAD_COLUMNS = `p.*, l.status, l.note, l.next_action_at, l.unlocked_at, l.updated_at AS l_updated,
  l.site_check, l.site_check_url, l.check_status, l.check_score, l.check_issues, l.checked_at`;

const leadOf = (r: LeadJoin) =>
  toPublic(withSiteCheck(r, r), true, {
    status: r.status,
    note: r.note,
    next_action_at: r.next_action_at,
    unlocked_at: r.unlocked_at,
    updated_at: r.l_updated,
    site_check: r.site_check,
    site_check_url: r.site_check_url,
    checked_at: r.checked_at,
  });

export function getLead(db: DB, userId: number, prospectId: string): PublicProspect | null {
  const r = db
    .prepare(`SELECT ${LEAD_COLUMNS} FROM leads l JOIN prospects p ON p.id = l.prospect_id WHERE l.user_id = ? AND l.prospect_id = ?`)
    .get(userId, prospectId) as LeadJoin | undefined;
  return r ? leadOf(r) : null;
}

export function listLeads(db: DB, userId: number): PublicProspect[] {
  const rows = db
    .prepare(
      `SELECT ${LEAD_COLUMNS} FROM leads l JOIN prospects p ON p.id = l.prospect_id WHERE l.user_id = ?
       ORDER BY (l.next_action_at IS NULL), l.next_action_at, l.updated_at DESC`,
    )
    .all(userId) as unknown as LeadJoin[];
  return rows.map(leadOf);
}

/**
 * Vérification du site par l'utilisateur sur un prospect débloqué :
 *  - « aucun site trouvé » : statut « Aucun site trouvé après vérification » ;
 *  - « site trouvé » + URL : le site est audité (requête protégée contre le SSRF) ;
 *  - null : on revient aux données de la source.
 * Le résultat reste propre au compte de l'utilisateur : une saisie ne modifie jamais la
 * fiche partagée vue par les autres utilisateurs.
 */
export async function setSiteCheck(
  db: DB,
  userId: number,
  prospectId: string,
  check: { kind: 'verified_none' | 'site_found' | null; url?: string | null },
  audit = auditWebsite,
): Promise<PublicProspect | null> {
  if (!getLead(db, userId, prospectId)) return null;
  const now = nowIso();
  const upd = db.prepare(
    `UPDATE leads SET site_check = ?, site_check_url = ?, check_status = ?, check_score = ?, check_issues = ?, checked_at = ?, updated_at = ?
     WHERE user_id = ? AND prospect_id = ?`,
  );
  if (check.kind === 'site_found') {
    const url = String(check.url ?? '').trim();
    if (classifyWebsite(url) === 'none') throw new Error('Adresse du site invalide');
    const kind = classifyWebsite(url);
    const r = kind === 'social' ? { status: 'social' as SiteStatus, score: null, issues: [] } : await audit(url);
    upd.run('site_found', url.slice(0, 300), r.status, r.score, JSON.stringify(r.issues), now, now, userId, prospectId);
  } else if (check.kind === 'verified_none') {
    upd.run('verified_none', null, null, null, null, now, now, userId, prospectId);
  } else {
    upd.run(null, null, null, null, null, null, now, userId, prospectId);
  }
  return getLead(db, userId, prospectId);
}

// --- Recalcul des scores ----------------------------------------------------------------

/** À incrémenter à chaque changement du barème d'opportunityDetails(). */
const SCORE_VERSION = '2';

/** Recalcule les scores stockés (tri des résultats) une fois par version du barème. */
export function rescoreIfNeeded(db: DB): number {
  const cur = db.prepare(`SELECT value FROM meta WHERE key = 'score_version'`).get() as { value: string } | undefined;
  if (cur?.value === SCORE_VERSION) return 0;
  const rows = db.prepare('SELECT id, site_status, audit_score, phone, email, created_on, updated_at FROM prospects').all() as unknown as ProspectRow[];
  const upd = db.prepare('UPDATE prospects SET opportunity = ? WHERE id = ?');
  tx(db, () => {
    for (const r of rows) upd.run(opportunityScore(r), r.id);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('score_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SCORE_VERSION);
  });
  return rows.length;
}

export function updateLead(db: DB, userId: number, prospectId: string, patch: { status?: unknown; note?: unknown; next_action_at?: unknown }): PublicProspect | null {
  const cur = getLead(db, userId, prospectId);
  if (!cur?.lead) return null;
  const status = typeof patch.status === 'string' && (LEAD_STATUSES as readonly string[]).includes(patch.status) ? patch.status : cur.lead.status;
  const note = typeof patch.note === 'string' ? patch.note.slice(0, 5000) : cur.lead.note;
  let next = cur.lead.next_action_at;
  if (patch.next_action_at === null || patch.next_action_at === '') next = null;
  else if (typeof patch.next_action_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.next_action_at)) next = patch.next_action_at;
  db.prepare('UPDATE leads SET status = ?, note = ?, next_action_at = ?, updated_at = ? WHERE user_id = ? AND prospect_id = ?').run(
    status, note, next, nowIso(), userId, prospectId,
  );
  return getLead(db, userId, prospectId);
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise les formules (injection CSV)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leadsCsv(leads: PublicProspect[]): string {
  const head = ['Nom', 'Métier', 'Adresse', 'Code postal', 'Ville', 'Téléphone', 'Email', 'Site', 'État du site', 'Score site', 'Opportunité', 'Statut', 'Prochaine action', 'Note', 'SIRET'];
  const lines = leads.map((l) =>
    [l.name, l.tradeLabel, l.address, l.postal_code, l.city, l.phone, l.email, l.website, l.statusLabel, l.audit_score, l.opportunity,
      l.lead?.status, l.lead?.next_action_at, l.lead?.note, l.siret].map(csvCell).join(';'),
  );
  return '﻿' + [head.join(';'), ...lines].join('\r\n');
}

/** Statistiques publiques (pages SEO) : agrégats seulement, jamais de coordonnées. */
export function cityStats(db: DB, cityCode: string): { total: number; nosite: number; weak: number; byTrade: { trade: string; n: number; nosite: number }[] } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(site_status IN ${SQL_NO_SITE}) AS nosite, SUM(site_status = 'weak') AS weak
       FROM prospects WHERE city_code = ?`,
    )
    .get(cityCode) as { total: number; nosite: number | null; weak: number | null };
  const byTrade = db
    .prepare(
      `SELECT trade, COUNT(*) AS n, SUM(site_status IN ${SQL_NO_SITE}) AS nosite FROM prospects
       WHERE city_code = ? GROUP BY trade ORDER BY n DESC`,
    )
    .all(cityCode) as { trade: string; n: number; nosite: number }[];
  return { total: Number(r.total), nosite: Number(r.nosite ?? 0), weak: Number(r.weak ?? 0), byTrade };
}
