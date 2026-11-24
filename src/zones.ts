// Zones de recherche : commune, département, région ou rayon autour d'une commune.
// Référentiel géographique : geo.api.gouv.fr (API officielle et gratuite de l'État).
//
// Stratégie pour les grandes zones (respect des quotas des sources publiques) :
//  - l'affichage interroge la base locale (instantané), filtrée sur la zone ;
//  - la collecte en direct est limitée aux communes les plus peuplées non encore analysées ;
//  - les autres communes passent dans une file traitée lentement en tâche de fond ;
//  - la couverture réelle (communes analysées / communes de la zone) est toujours affichée.

import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import type { Commune } from './sources.ts';

const UA = 'Sitolead/1.0 (outil de prospection B2B)';
const GEO = 'https://geo.api.gouv.fr';

export type ZoneKind = 'commune' | 'departement' | 'region' | 'rayon';

export interface ZoneCommune extends Commune {
  lat: number | null;
  lon: number | null;
}

export interface Zone {
  kind: ZoneKind;
  /** Identifiant stable, ex. « dep:74 », « rayon:74010:20 ». */
  key: string;
  label: string;
  /** Communes de la zone (référentiel complet). */
  communes: ZoneCommune[];
  /** Filtre côté base : préfixes de code INSEE (département / région) ou liste de codes (rayon). */
  prefixes?: string[];
  codes?: string[];
  /** Rayon : centre et distance (km), appliqués sur la position des entreprises. */
  center?: { lat: number; lon: number; km: number };
}

async function geo<T>(path: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(GEO + path, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`geo.api.gouv.fr a répondu ${res.status}`);
  return (await res.json()) as T;
}

interface GeoCommune {
  code: string;
  nom: string;
  population?: number;
  codesPostaux?: string[];
  departement?: { code: string };
  codeDepartement?: string;
  centre?: { coordinates: [number, number] };
}

const toZoneCommune = (r: GeoCommune): ZoneCommune => ({
  code: r.code,
  nom: r.nom,
  departement: r.departement?.code ?? r.codeDepartement ?? r.code.slice(0, 2),
  population: r.population ?? 0,
  codesPostaux: r.codesPostaux ?? [],
  lon: r.centre?.coordinates[0] ?? null,
  lat: r.centre?.coordinates[1] ?? null,
});

const FIELDS = 'fields=code,nom,population,codesPostaux,codeDepartement,centre';

// Les référentiels changent rarement : cache mémoire d'une journée.
const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 86_400_000) return hit.value as T;
  const value = await fn();
  if (cache.size > 500) cache.clear();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export const departementCommunes = (dep: string) =>
  cached(`dep:${dep}`, async () => (await geo<GeoCommune[]>(`/departements/${encodeURIComponent(dep)}/communes?${FIELDS}`)).map(toZoneCommune));

export const departementName = (dep: string) =>
  cached(`depname:${dep}`, async () => (await geo<{ nom: string }>(`/departements/${encodeURIComponent(dep)}`)).nom);

export const regionInfo = (code: string) =>
  cached(`reg:${code}`, async () => {
    const [r, deps] = await Promise.all([
      geo<{ nom: string }>(`/regions/${encodeURIComponent(code)}`),
      geo<{ code: string }[]>(`/regions/${encodeURIComponent(code)}/departements`),
    ]);
    return { nom: r.nom, departements: deps.map((d) => d.code) };
  });

export const communeWithCentre = (code: string) =>
  cached(`com:${code}`, async () => toZoneCommune(await geo<GeoCommune>(`/communes/${encodeURIComponent(code)}?${FIELDS}`)));

/** Distance orthodromique en kilomètres. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const RADIUS_KM = [5, 10, 20, 30, 50] as const;
/** Codes de département existants : 01 à 95 (sauf 20), 2A, 2B, 971 à 976. */
const DEP_RE = /^(0[1-9]|1\d|2[1-9AB]|[3-8]\d|9[0-5]|97[1-6])$/i;
const COMMUNE_RE = /^[0-9][0-9AB][0-9]{3}$/i;

/** Analyse un paramètre de zone : « commune:74010 », « departement:74 », « region:84 », « rayon:74010:20 ». */
export function parseZone(raw: string): { kind: ZoneKind; code: string; km?: number } | null {
  const [kind, code, km] = raw.split(':');
  if (kind === 'commune' && code && COMMUNE_RE.test(code)) return { kind, code: code.toUpperCase() };
  if (kind === 'departement' && code && DEP_RE.test(code)) return { kind, code: code.toUpperCase() };
  if (kind === 'region' && code && /^\d{2}$/.test(code)) return { kind, code };
  if (kind === 'rayon' && code && COMMUNE_RE.test(code) && (RADIUS_KM as readonly number[]).includes(Number(km))) {
    return { kind, code: code.toUpperCase(), km: Number(km) };
  }
  return null;
}

/** Résout une zone multi-communes (département, région, rayon) avec le référentiel officiel. */
export async function resolveZone(z: { kind: Exclude<ZoneKind, 'commune'>; code: string; km?: number }): Promise<Zone> {
  if (z.kind === 'departement') {
    const [nom, communes] = await Promise.all([departementName(z.code), departementCommunes(z.code)]);
    return { kind: 'departement', key: `departement:${z.code}`, label: `${nom} (${z.code})`, communes, prefixes: [z.code] };
  }
  if (z.kind === 'region') {
    const r = await regionInfo(z.code);
    const lists = await Promise.all(r.departements.map((d) => departementCommunes(d)));
    return { kind: 'region', key: `region:${z.code}`, label: r.nom, communes: lists.flat(), prefixes: r.departements };
  }
  const center = await communeWithCentre(z.code);
  if (center.lat === null || center.lon === null) throw new Error('Position de la commune inconnue');
  const km = z.km ?? 10;
  const c = { lat: center.lat, lon: center.lon };
  // Communes du département du centre, et des départements voisins quand le rayon peut les atteindre.
  const deps = new Set([center.departement]);
  if (km >= 10) for (const d of NEIGHBOURS[center.departement] ?? []) deps.add(d);
  const lists = await Promise.all([...deps].map((d) => departementCommunes(d).catch(() => [] as ZoneCommune[])));
  const communes = lists.flat().filter((x) => x.lat !== null && x.lon !== null && distanceKm(c, { lat: x.lat, lon: x.lon }) <= km);
  return {
    kind: 'rayon',
    key: `rayon:${z.code}:${km}`,
    label: `${center.nom} et ${km} km autour`,
    communes,
    codes: communes.map((x) => x.code),
    center: { ...c, km },
  };
}

// --- Couverture et file de collecte ----------------------------------------------------

const analysedCodes = (db: DB, trade: string) =>
  new Set((db.prepare('SELECT city_code FROM searches WHERE trade = ?').all(trade) as { city_code: string }[]).map((r) => r.city_code));

/** Communes de la zone déjà analysées pour ce métier (recherche en cache, même partielle). */
export function zoneCoverage(db: DB, zone: Zone, trade: string): { analysed: number; total: number } {
  const done = analysedCodes(db, trade);
  return { analysed: zone.communes.filter((c) => done.has(c.code)).length, total: zone.communes.length };
}

/** Plafond de communes mises en file par recherche de zone (une région peut en compter des milliers). */
const QUEUE_PER_ZONE = 150;

/** Communes à collecter maintenant (les plus peuplées non analysées) ; les suivantes vont en file. */
export function planCollection(db: DB, zone: Zone, trade: string, now = 5): { collectNow: ZoneCommune[]; queued: number } {
  const done = analysedCodes(db, trade);
  const todo = zone.communes.filter((c) => !done.has(c.code)).sort((a, b) => b.population - a.population);
  const collectNow = todo.slice(0, now);
  const rest = todo.slice(now, now + QUEUE_PER_ZONE);
  const ins = db.prepare(
    `INSERT INTO collect_queue (city_code, city_name, departement, trade, population, requested_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(city_code, trade) DO NOTHING`,
  );
  const at = nowIso();
  for (const c of rest) ins.run(c.code, c.nom, c.departement, trade, c.population, at);
  return { collectNow, queued: rest.length };
}

export function nextQueued(db: DB, limit: number): { city_code: string; city_name: string; departement: string; trade: string }[] {
  return db
    .prepare('SELECT city_code, city_name, departement, trade FROM collect_queue ORDER BY population DESC, requested_at LIMIT ?')
    .all(limit) as { city_code: string; city_name: string; departement: string; trade: string }[];
}

export function dequeue(db: DB, cityCode: string, trade: string): void {
  db.prepare('DELETE FROM collect_queue WHERE city_code = ? AND trade = ?').run(cityCode, trade);
}

/** Recherche de départements et régions par nom ou numéro (autocomplétion). */
export async function searchAreas(q: string): Promise<{ type: 'departement' | 'region'; code: string; nom: string }[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const isDepCode = DEP_RE.test(term);
  const [deps, regs] = await Promise.all([
    isDepCode
      ? geo<{ code: string; nom: string }>(`/departements/${encodeURIComponent(term.toUpperCase())}`).then((d) => [d]).catch(() => [])
      : geo<{ code: string; nom: string }[]>(`/departements?nom=${encodeURIComponent(term)}&limit=3`).catch(() => []),
    isDepCode ? Promise.resolve([]) : geo<{ code: string; nom: string }[]>(`/regions?nom=${encodeURIComponent(term)}&limit=2`).catch(() => []),
  ]);
  return [
    ...deps.slice(0, 3).map((d) => ({ type: 'departement' as const, code: d.code, nom: d.nom })),
    ...regs.slice(0, 2).map((r) => ({ type: 'region' as const, code: r.code, nom: r.nom })),
  ];
}

// Départements limitrophes (métropole), pour les recherches par rayon qui débordent du département.
// Les départements d'outre-mer n'ont pas de voisin terrestre.
const NEIGHBOURS: Record<string, string[]> = {
  '01': ['38', '39', '69', '71', '73', '74'], '02': ['08', '51', '59', '60', '77', '80'], '03': ['18', '23', '42', '58', '63', '71'],
  '04': ['05', '06', '13', '26', '83', '84'], '05': ['04', '26', '38', '73'], '06': ['04', '83'], '07': ['26', '30', '38', '42', '43', '48', '84'],
  '08': ['02', '51', '55'], '09': ['11', '31', '66'], '10': ['21', '51', '52', '77', '89'], '11': ['09', '31', '34', '66', '81'],
  '12': ['15', '30', '34', '46', '48', '81', '82'], '13': ['04', '30', '83', '84'], '14': ['27', '50', '61', '76'], '15': ['12', '19', '43', '46', '48', '63'],
  '16': ['17', '24', '79', '86', '87'], '17': ['16', '24', '33', '79', '85'], '18': ['03', '23', '36', '41', '45', '58'], '19': ['15', '23', '24', '46', '63', '87'],
  '2A': ['2B'], '2B': ['2A'], '21': ['10', '39', '52', '58', '70', '71', '89'], '22': ['29', '35', '56'], '23': ['03', '18', '19', '36', '63', '87'],
  '24': ['16', '17', '19', '33', '46', '47', '87'], '25': ['39', '70', '90'], '26': ['04', '05', '07', '38', '84'], '27': ['14', '28', '60', '61', '76', '78', '95'],
  '28': ['27', '41', '45', '61', '72', '78', '91'], '29': ['22', '56'], '30': ['07', '12', '13', '34', '48', '84'], '31': ['09', '11', '32', '65', '81', '82'],
  '32': ['31', '40', '47', '64', '65', '82'], '33': ['17', '24', '40', '47'], '34': ['11', '12', '30', '81'], '35': ['22', '44', '49', '50', '53', '56'],
  '36': ['18', '23', '37', '41', '86', '87'], '37': ['36', '41', '49', '72', '86'], '38': ['01', '05', '07', '26', '42', '69', '73'], '39': ['01', '21', '25', '70', '71'],
  '40': ['32', '33', '47', '64'], '41': ['18', '28', '36', '37', '45', '72'], '42': ['03', '07', '38', '43', '63', '69', '71'], '43': ['07', '15', '42', '48', '63'],
  '44': ['35', '49', '56', '85'], '45': ['18', '28', '41', '58', '77', '89', '91'], '46': ['12', '15', '19', '24', '47', '82'], '47': ['24', '32', '33', '40', '46', '82'],
  '48': ['07', '12', '15', '30', '43'], '49': ['35', '37', '44', '53', '72', '79', '85', '86'], '50': ['14', '35', '53', '61'], '51': ['02', '08', '10', '52', '55', '77'],
  '52': ['10', '21', '51', '55', '70', '88'], '53': ['35', '49', '50', '61', '72'], '54': ['55', '57', '67', '88'], '55': ['08', '51', '52', '54', '88'],
  '56': ['22', '29', '35', '44'], '57': ['54', '67'], '58': ['03', '18', '21', '45', '71', '89'], '59': ['02', '62', '80'], '60': ['02', '27', '76', '77', '80', '95'],
  '61': ['14', '27', '28', '50', '53', '72'], '62': ['59', '80'], '63': ['03', '15', '19', '23', '42', '43'], '64': ['32', '40', '65'], '65': ['31', '32', '64'],
  '66': ['09', '11'], '67': ['54', '57', '68', '88'], '68': ['67', '88', '90'], '69': ['01', '38', '42', '71'], '70': ['21', '25', '39', '52', '88', '90'],
  '71': ['01', '03', '21', '39', '42', '58', '69'], '72': ['28', '37', '41', '49', '53', '61'], '73': ['01', '05', '38', '74'], '74': ['01', '73'],
  '75': ['92', '93', '94'], '76': ['14', '27', '60', '80'], '77': ['02', '10', '45', '51', '60', '89', '91', '93', '94', '95'], '78': ['27', '28', '91', '92', '95'],
  '79': ['16', '17', '49', '85', '86'], '80': ['02', '59', '60', '62', '76'], '81': ['11', '12', '31', '34', '82'], '82': ['12', '31', '32', '46', '47', '81'],
  '83': ['04', '06', '13', '84'], '84': ['04', '07', '13', '26', '30', '83'], '85': ['17', '44', '49', '79'], '86': ['16', '36', '37', '49', '79', '87'],
  '87': ['16', '19', '23', '24', '36', '86'], '88': ['52', '54', '55', '67', '68', '70', '90'], '89': ['10', '21', '45', '58', '77'], '90': ['25', '68', '70', '88'],
  '91': ['28', '45', '77', '78', '92', '94'], '92': ['75', '78', '91', '93', '94', '95'], '93': ['75', '77', '92', '94', '95'], '94': ['75', '77', '91', '92', '93'],
  '95': ['27', '60', '77', '78', '92', '93'],
};
