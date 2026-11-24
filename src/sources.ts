// Sources de prospects réelles et gratuites :
//  - OpenStreetMap (Overpass) : commerces et artisans avec téléphone / site web déclaré ;
//  - Annuaire des entreprises (SIRENE, api.gouv.fr) : entreprises créées récemment.
//  - geo.api.gouv.fr : résolution d'une commune (code INSEE).

import type { Trade } from './catalog.ts';

const UA = 'Sitolead/1.0 (outil de prospection B2B)';

export interface RawProspect {
  id: string;
  source: 'osm' | 'sirene' | 'demo';
  siret: string | null;
  name: string;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  lat: number | null;
  lon: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  created_on: string | null;
}

export interface Commune {
  code: string;
  nom: string;
  departement: string;
  population: number;
  codesPostaux: string[];
}

async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 25_000): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} a répondu ${res.status}`);
  return (await res.json()) as T;
}

// --- Communes -----------------------------------------------------------------

interface GeoCommune {
  code: string;
  nom: string;
  population?: number;
  codesPostaux?: string[];
  departement?: { code: string };
}
const toCommune = (r: GeoCommune): Commune => ({
  code: r.code,
  nom: r.nom,
  departement: r.departement?.code ?? r.code.slice(0, 2),
  population: r.population ?? 0,
  codesPostaux: r.codesPostaux ?? [],
});

export async function searchCommunes(q: string, limit = 8): Promise<Commune[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const param = /^\d{5}$/.test(term) ? `codePostal=${term}` : `nom=${encodeURIComponent(term)}`;
  const rows = await getJson<GeoCommune[]>(
    `https://geo.api.gouv.fr/communes?${param}&fields=code,nom,codesPostaux,population,departement&boost=population&limit=${limit}`,
    {},
    8000,
  );
  return rows.map(toCommune);
}

export async function communeByCode(code: string): Promise<Commune | null> {
  if (!/^[0-9][0-9AB][0-9]{3}$/i.test(code)) return null;
  try {
    return toCommune(await getJson<GeoCommune>(`https://geo.api.gouv.fr/communes/${code}?fields=code,nom,codesPostaux,population,departement`, {}, 8000));
  } catch {
    return null;
  }
}

// --- OpenStreetMap ------------------------------------------------------------

// Instances Overpass publiques : gratuites mais partagées, à n'utiliser qu'avec modération
// (politique d'usage : quelques milliers de requêtes / jour maximum, une à la fois).
// En production, configurez votre propre instance via OVERPASS_URL (voir docs/DEPLOIEMENT.md).
const PUBLIC_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const overpassEndpoints = (): string[] => {
  const own = (process.env.OVERPASS_URL ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return own.length ? own : PUBLIC_OVERPASS;
};
export const usingPublicOverpass = (): boolean => !process.env.OVERPASS_URL?.trim();
/** Une requête par ville (tous les métiers) peut être lourde pour une grande ville. */
const OSM_BUDGET_MS = 60_000;

export interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function osmToProspect(el: OsmElement, cityName: string): RawProspect | null {
  const t = el.tags ?? {};
  const name = t.name;
  if (!name) return null;
  // Les enseignes nationales ne sont pas des prospects : leur site est géré par le siège.
  if (t['brand:wikidata']) return null;
  const website = t.website ?? t['contact:website'] ?? t.url ?? t['contact:facebook'] ?? t.facebook ?? t['contact:instagram'] ?? null;
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    id: `osm:${el.type}/${el.id}`,
    source: 'osm',
    siret: t['ref:FR:SIRET']?.replace(/\s/g, '') || null,
    name,
    address: street || null,
    postal_code: t['addr:postcode'] ?? null,
    city: t['addr:city'] ?? cityName,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
    phone: t.phone ?? t['contact:phone'] ?? t['contact:mobile'] ?? null,
    email: t.email ?? t['contact:email'] ?? null,
    website,
    created_on: null,
  };
}

/** Métier d'un élément OpenStreetMap d'après ses tags (premier métier qui correspond). */
export function osmTrade(tags: Record<string, string> | undefined, trades: Trade[]): Trade | undefined {
  if (!tags) return undefined;
  return trades.find((t) => tags[t.osm[0]] === t.osm[1]);
}

/**
 * Tous les métiers d'une commune en UNE requête Overpass (au lieu d'une par métier) :
 * les serveurs publics étant saturés, chaque requête évitée compte.
 */
export async function fetchOsmCity(commune: Commune, trades: Trade[]): Promise<Map<string, RawProspect[]>> {
  // Regroupe les valeurs par clé : craft~"^(plumber|electrician|…)$", shop~"^(bakery|…)$"…
  const byKey = new Map<string, string[]>();
  for (const t of trades) byKey.set(t.osm[0], [...(byKey.get(t.osm[0]) ?? []), t.osm[1]]);
  const selectors = [...byKey].map(([k, vs]) => `nwr["${k}"~"^(${vs.join('|')})$"]["name"](area.a);`).join('');
  const query = `[out:json][timeout:${Math.round(OSM_BUDGET_MS / 1000)}];area["ref:INSEE"="${commune.code}"]["boundary"="administrative"]->.a;(${selectors});out center tags;`;
  const elements = await overpass(query);
  const out = new Map<string, RawProspect[]>(trades.map((t) => [t.slug, []]));
  for (const el of elements) {
    const trade = osmTrade(el.tags, trades);
    const p = trade ? osmToProspect(el, commune.nom) : null;
    if (trade && p) out.get(trade.slug)!.push(p);
  }
  return out;
}

// Une seule requête Overpass à la fois pour tout le serveur : les instances publiques
// limitent le nombre de requêtes simultanées par adresse IP, et c'est la règle de politesse.
let overpassChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = overpassChain.then(fn, fn);
  overpassChain = run.catch(() => {});
  return run;
}

/**
 * Interroge les instances l'une après l'autre (bascule si la première est saturée), dans un
 * budget de temps global. Jamais plusieurs instances en parallèle : ce serait multiplier la
 * charge sur des serveurs publics partagés.
 */
function overpass(query: string): Promise<OsmElement[]> {
  return oneAtATime(async () => {
    const deadline = AbortSignal.timeout(OSM_BUDGET_MS);
    let last = 'OpenStreetMap indisponible';
    for (const endpoint of overpassEndpoints()) {
      if (deadline.aborted) break;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal: deadline,
          headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new Error(`${new URL(endpoint).hostname} a répondu ${res.status}`);
        }
        const body = (await res.json()) as { elements?: OsmElement[]; remark?: string };
        // Overpass renvoie 200 avec une « remark » quand la requête a expiré côté serveur.
        if (!body.elements || (body.remark && /timed out|out of memory/i.test(body.remark))) throw new Error('réponse incomplète');
        return body.elements;
      } catch (e) {
        last = (e as Error).message;
      }
    }
    throw new Error(
      deadline.aborted || /429|50[234]/.test(last)
        ? 'OpenStreetMap ne répond pas (serveurs saturés), nouvel essai automatique plus tard'
        : `OpenStreetMap indisponible (${last})`,
    );
  });
}

// --- SIRENE : entreprises récentes ---------------------------------------------

export interface SireneEtab {
  siret: string;
  commune: string;
  etat_administratif: string;
  activite_principale: string;
  adresse: string;
  code_postal: string;
  libelle_commune: string;
  date_creation: string | null;
  latitude: string | null;
  longitude: string | null;
  nom_commercial: string | null;
  liste_enseignes: string[] | null;
  statut_diffusion_etablissement?: string;
}
export interface SireneResult {
  siren?: string;
  nom_complet: string;
  /** 'O' : diffusion complète ; 'P' : diffusion partielle (données protégées). */
  statut_diffusion?: string;
  /** L'entrepreneur s'est opposé à l'utilisation de ses données pour la prospection commerciale. */
  opposition_diffusion_commerciale?: boolean;
  matching_etablissements?: SireneEtab[];
}

const ND = /NON-DIFFUSIBLE/i;

/**
 * Une entreprise qui s'oppose à la prospection, ou dont les données sont en diffusion
 * partielle, ne doit jamais être proposée (RGPD, conditions de réutilisation SIRENE).
 */
export function sireneBlocked(r: SireneResult, e?: SireneEtab): boolean {
  if (r.opposition_diffusion_commerciale === true) return true;
  if (r.statut_diffusion && r.statut_diffusion !== 'O') return true;
  if (ND.test(r.nom_complet)) return true;
  if (!e) return false;
  if (e.statut_diffusion_etablissement && e.statut_diffusion_etablissement !== 'O') return true;
  return [e.adresse, e.code_postal, e.libelle_commune, e.nom_commercial, ...(e.liste_enseignes ?? [])].some((v) => v && ND.test(v));
}

const LEGAL_FORMS = new Set(['SA', 'SAS', 'SASU', 'SARL', 'EURL', 'EI', 'EIRL', 'SCI', 'SCP', 'SCM', 'SNC', 'SCOP', 'SEL', 'SELARL', 'SELAS', 'GIE', 'GAEC']);
const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'à', 'au', 'aux', 'en', 'sur', 'sous']);

/** « PLOMBERIE DU LAC SARL » → « Plomberie du Lac SARL ». Ne touche pas un texte déjà en casse mixte. */
export function prettyName(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t !== t.toUpperCase() || !/\p{L}/u.test(t)) return t;
  return t
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      const bare = w.replace(/[()]/g, '').toUpperCase();
      if (LEGAL_FORMS.has(bare)) return w.toUpperCase();
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w.replace(/(^|[-'’(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
    })
    .join(' ');
}

const range = (prefix: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(prefix * 100 + from + i));

/** Paris, Lyon et Marseille sont enregistrées par arrondissement dans SIRENE, pas sous leur code de commune. */
const ARRONDISSEMENTS: Record<string, string[]> = {
  '75056': range(751, 1, 20), // 75101 … 75120
  '69123': range(693, 81, 89), // 69381 … 69389
  '13055': range(132, 1, 16), // 13201 … 13216
};

/** Codes INSEE à interroger dans SIRENE pour une commune (ses arrondissements le cas échéant). */
export const sireneCommuneCodes = (code: string): string[] => ARRONDISSEMENTS[code] ?? [code];

export function sireneToProspects(results: SireneResult[], commune: Commune, naf: string, maxAgeMonths: number, now = new Date()): RawProspect[] {
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - maxAgeMonths);
  const codes = new Set(sireneCommuneCodes(commune.code));
  const out: RawProspect[] = [];
  for (const r of results) {
    if (sireneBlocked(r)) continue;
    for (const e of r.matching_etablissements ?? []) {
      if (!codes.has(e.commune) || e.etat_administratif !== 'A' || e.activite_principale !== naf) continue;
      if (!e.date_creation || new Date(e.date_creation) < limit) continue;
      if (sireneBlocked(r, e)) continue;
      const name = e.liste_enseignes?.[0] || e.nom_commercial || r.nom_complet;
      const cut = e.adresse.indexOf(` ${e.code_postal}`);
      const address = (cut > 0 ? e.adresse.slice(0, cut) : e.adresse).trim();
      out.push({
        id: `sirene:${e.siret}`,
        source: 'sirene',
        siret: e.siret,
        name: prettyName(name),
        address: address ? prettyName(address) : null,
        postal_code: e.code_postal,
        city: prettyName(e.libelle_commune),
        lat: e.latitude ? Number(e.latitude) : null,
        lon: e.longitude ? Number(e.longitude) : null,
        phone: null,
        email: null,
        website: null,
        created_on: e.date_creation,
      });
    }
  }
  return out;
}

/** SIREN des entreprises opposées à la prospection : servent à écarter aussi leurs fiches OpenStreetMap. */
export function sireneOptOuts(results: SireneResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    if (r.opposition_diffusion_commerciale === true || (r.statut_diffusion && r.statut_diffusion !== 'O')) {
      const siren = r.siren ?? r.matching_etablissements?.[0]?.siret.slice(0, 9);
      if (siren && /^\d{9}$/.test(siren)) out.add(siren);
    }
  }
  return [...out];
}

// L'API annonce 7 requêtes / seconde par adresse IP mais renvoie des 429 bien avant :
// on espace chaque appel d'au moins 250 ms (4 / s) pour tout le serveur, quelle que soit
// la recherche qui le demande, et on retente les refus passagers.
const SIRENE_GAP_MS = 250;
// Deux files : les recherches des utilisateurs passent avant le préchargement en tâche de fond.
const sireneQueues = { user: [] as (() => void)[], background: [] as (() => void)[] };
let sireneLast = 0;
let sireneTicking = false;
function sireneTick(): void {
  if (sireneTicking) return;
  const next = sireneQueues.user.shift() ?? sireneQueues.background.shift();
  if (!next) return;
  sireneTicking = true;
  setTimeout(() => {
    sireneLast = Date.now();
    sireneTicking = false;
    next();
    sireneTick();
  }, Math.max(0, sireneLast + SIRENE_GAP_MS - Date.now()));
}
function sireneSlot(background: boolean): Promise<void> {
  return new Promise((resolve) => {
    sireneQueues[background ? 'background' : 'user'].push(resolve);
    sireneTick();
  });
}

const SIRENE_MAX_PAGES = 40;

export async function fetchSirene(
  commune: Commune,
  trade: Trade,
  opts: { maxAgeMonths?: number; background?: boolean } = {},
): Promise<{ prospects: RawProspect[]; optOuts: string[] }> {
  const maxAgeMonths = opts.maxAgeMonths ?? 24;
  const base =
    `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${encodeURIComponent(trade.naf)}` +
    `&code_commune=${sireneCommuneCodes(commune.code).join(',')}&etat_administratif=A&per_page=25&page=`;
  const page = async (n: number) => {
    // Refus pour trop de requêtes (429) ou coupure réseau : jusqu'à 3 nouvelles tentatives, de plus en plus espacées.
    for (let attempt = 0; ; attempt++) {
      await sireneSlot(Boolean(opts.background));
      try {
        return await getJson<{ results: SireneResult[]; total_pages: number }>(base + n, {}, 15_000);
      } catch (e) {
        const transient = /429|50[234]|fetch failed|timeout/i.test((e as Error).message);
        if (!transient || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };
  // L'API ne filtre pas par date de création : on parcourt toutes les pages (plafonnées).
  // La première donne le nombre de pages, les suivantes partent en parallèle (au rythme autorisé).
  const first = await page(1);
  const rest = await Promise.all(Array.from({ length: Math.min(first.total_pages, SIRENE_MAX_PAGES) - 1 }, (_, i) => page(i + 2)));
  const results = [first, ...rest].flatMap((d) => d.results);
  return { prospects: sireneToProspects(results, commune, trade.naf, maxAgeMonths), optOuts: sireneOptOuts(results) };
}
