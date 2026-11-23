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

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_BUDGET_MS = 30_000;

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

export async function fetchOsm(commune: Commune, trade: Trade): Promise<RawProspect[]> {
  const [k, v] = trade.osm;
  const query = `[out:json][timeout:25];area["ref:INSEE"="${commune.code}"]["boundary"="administrative"]->.a;nwr["${k}"="${v}"]["name"](area.a);out center tags 500;`;
  // Les serveurs Overpass publics sont souvent saturés : on les interroge tous en même temps,
  // le premier qui répond gagne et les autres requêtes sont annulées.
  const stop = new AbortController();
  const deadline = AbortSignal.timeout(OSM_BUDGET_MS);
  const signal = AbortSignal.any([stop.signal, deadline]);
  try {
    const data = await Promise.any(
      OVERPASS.map(async (endpoint) => {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal,
          headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        });
        if (!res.ok) throw new Error(`${new URL(endpoint).hostname} a répondu ${res.status}`);
        const body = (await res.json()) as { elements?: OsmElement[]; remark?: string };
        // Overpass renvoie 200 avec une « remark » quand la requête a expiré côté serveur.
        if (!body.elements || (body.remark && /timed out|out of memory/i.test(body.remark))) throw new Error('réponse incomplète');
        return body.elements;
      }),
    );
    return data.map((e) => osmToProspect(e, commune.nom)).filter((p): p is RawProspect => p !== null);
  } catch {
    throw new Error(deadline.aborted ? 'OpenStreetMap ne répond pas (serveurs saturés), réessayez plus tard' : 'OpenStreetMap indisponible');
  } finally {
    stop.abort();
  }
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

export function sireneToProspects(results: SireneResult[], commune: Commune, naf: string, maxAgeMonths: number, now = new Date()): RawProspect[] {
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - maxAgeMonths);
  const out: RawProspect[] = [];
  for (const r of results) {
    if (sireneBlocked(r)) continue;
    for (const e of r.matching_etablissements ?? []) {
      if (e.commune !== commune.code || e.etat_administratif !== 'A' || e.activite_principale !== naf) continue;
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

export async function fetchSirene(commune: Commune, trade: Trade, maxAgeMonths = 24): Promise<{ prospects: RawProspect[]; optOuts: string[] }> {
  const prospects: RawProspect[] = [];
  const optOuts: string[] = [];
  // L'API ne filtre pas par date de création : on parcourt toutes les pages (plafonnées).
  for (let page = 1; page <= 12; page++) {
    const url =
      `https://recherche-entreprises.api.gouv.fr/search?activite_principale=${encodeURIComponent(trade.naf)}` +
      `&code_commune=${commune.code}&etat_administratif=A&per_page=25&page=${page}`;
    const data = await getJson<{ results: SireneResult[]; total_pages: number }>(url, {}, 15_000);
    prospects.push(...sireneToProspects(data.results, commune, trade.naf, maxAgeMonths));
    optOuts.push(...sireneOptOuts(data.results));
    if (page >= data.total_pages) break;
    await new Promise((r) => setTimeout(r, 300)); // l'API limite à 7 requêtes / seconde
  }
  return { prospects, optOuts };
}
