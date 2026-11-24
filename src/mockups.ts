// Maquettes de sites vitrines : un moteur de rendu unique et des préréglages par secteur
// (pas de projet ni de déploiement par prospect). Chaque maquette est un contenu éditable
// stocké en base, servi par le serveur principal sur /p/<identifiant secret>.
//
// Règles de contenu : uniquement des informations réelles (nom, métier, ville, coordonnées
// publiques) ou saisies par l'utilisateur. Aucun avis, certification, tarif, ancienneté ni
// témoignage n'est inventé ; les prestations proposées par défaut sont des suggestions à
// valider avec l'entreprise, et la page indique toujours qu'il s'agit d'une proposition.

import { randomBytes } from 'node:crypto';
import { effectivePlan, type UserRow } from './billing.ts';
import { tradeBySlug } from './catalog.ts';
import { nowIso, type DB } from './db.ts';
import type { PublicProspect } from './prospects.ts';
import { titleCase } from './scoring.ts';
import { esc } from './seo.ts';

// --- Secteurs ---------------------------------------------------------------------------

export type SectorId =
  | 'plomberie' | 'electricite' | 'climatisation' | 'maconnerie' | 'couverture' | 'paysagisme'
  | 'automobile' | 'restauration' | 'beaute' | 'commerce' | 'services';

// Illustrations vectorielles maison (aucune image tierce : pas de question de licence).
const ART = {
  water: '<path d="M60 14c14 20 26 34 26 50a26 26 0 0 1-52 0c0-16 12-30 26-50z"/>',
  bolt: '<path d="M68 8 30 66h24l-6 46 40-60H64z"/>',
  air: '<path d="M14 44h62a12 12 0 1 0-12-12M14 64h80a14 14 0 1 1-14 14M14 84h44"/>',
  bricks: '<path d="M10 30h46v20H10zM64 30h46v20H64zM10 58h24v20H10zM42 58h46v20H42zM96 58h14v20H96zM10 86h46v20H10zM64 86h46v20H64z"/>',
  roof: '<path d="M8 66 60 20l52 46h-14v40H22V66z"/>',
  leaf: '<path d="M20 100C20 50 54 18 104 16c-2 50-34 84-84 84zm0 0 46-46"/>',
  car: '<path d="M16 76l10-28c2-6 7-10 13-10h42c6 0 11 4 13 10l10 28v22h-14v-10H30v10H16zm16-4a8 8 0 1 0 0 1zm56 0a8 8 0 1 0 0 1z"/>',
  plate: '<path d="M60 22a38 38 0 1 0 0 76 38 38 0 0 0 0-76zm0 16a22 22 0 1 1 0 44 22 22 0 0 1 0-44zM14 18v84M106 18v84"/>',
  scissors: '<path d="M38 30a12 12 0 1 0 0 1zM38 90a12 12 0 1 0 0 1zM48 38l56 50M48 82l56-50"/>',
  shop: '<path d="M14 46 24 18h72l10 28zM20 46v54h80V46M48 100V72h24v28"/>',
  spark: '<path d="M60 10l10 40 40 10-40 10-10 40-10-40-40-10 40-10z"/>',
};
type ArtKey = keyof typeof ART;
export const ART_KEYS = Object.keys(ART) as ArtKey[];

interface Sector {
  id: SectorId;
  label: string;
  primary: string;
  accent: string;
  /** Accroche par défaut : {nom}, {ville} remplacés. */
  tagline: string;
  /** Présentation par défaut, sans aucun fait inventé. */
  about: string;
  /** Prestations courantes du métier : suggestions à valider avec l'entreprise. */
  services: string[];
  cta: string;
  art: ArtKey;
}

export const SECTORS: Record<SectorId, Sector> = {
  plomberie: {
    id: 'plomberie', label: 'Plomberie', primary: '#0f4c81', accent: '#f2a541', art: 'water',
    tagline: 'Votre plombier à {ville} et alentours',
    about: '{nom} intervient à {ville} et dans les environs pour vos travaux de plomberie. Contactez-nous pour décrire votre besoin : nous vous répondons rapidement.',
    services: ['Dépannage et recherche de fuite', 'Installation et remplacement de sanitaires', 'Chauffe-eau et ballon d’eau chaude', 'Rénovation de salle de bains'],
    cta: 'Demander une intervention',
  },
  electricite: {
    id: 'electricite', label: 'Électricité', primary: '#1f2a44', accent: '#f6c445', art: 'bolt',
    tagline: 'Votre électricien à {ville} et alentours',
    about: '{nom} réalise vos travaux d’électricité à {ville} et dans les environs. Décrivez-nous votre projet ou votre panne : nous revenons vers vous rapidement.',
    services: ['Dépannage électrique', 'Mise en conformité', 'Tableau électrique', 'Éclairage intérieur et extérieur'],
    cta: 'Demander un devis',
  },
  climatisation: {
    id: 'climatisation', label: 'Climatisation', primary: '#0e6e8c', accent: '#7cc6de', art: 'air',
    tagline: 'Climatisation et confort thermique à {ville}',
    about: '{nom} installe et entretient vos équipements de climatisation à {ville} et dans les environs. Parlez-nous de votre logement ou de votre local.',
    services: ['Installation de climatisation', 'Pompe à chaleur', 'Entretien et maintenance', 'Dépannage'],
    cta: 'Demander un devis',
  },
  maconnerie: {
    id: 'maconnerie', label: 'Maçonnerie et bâtiment', primary: '#5b4636', accent: '#d9a066', art: 'bricks',
    tagline: 'Vos travaux à {ville} et alentours',
    about: '{nom} réalise vos travaux à {ville} et dans les environs. Présentez-nous votre projet : nous étudions votre demande.',
    services: ['Construction et extension', 'Rénovation', 'Murs et clôtures', 'Dalles et terrasses'],
    cta: 'Demander un devis',
  },
  couverture: {
    id: 'couverture', label: 'Couverture', primary: '#3d3f46', accent: '#c4553b', art: 'roof',
    tagline: 'Couverture et toiture à {ville}',
    about: '{nom} intervient sur vos toitures à {ville} et dans les environs. Décrivez-nous votre besoin : nous vous recontactons.',
    services: ['Réparation de toiture', 'Rénovation de couverture', 'Zinguerie et gouttières', 'Nettoyage et démoussage'],
    cta: 'Demander un devis',
  },
  paysagisme: {
    id: 'paysagisme', label: 'Paysagisme', primary: '#2f5d3a', accent: '#a8c66c', art: 'leaf',
    tagline: 'Création et entretien de jardins à {ville}',
    about: '{nom} crée et entretient vos espaces verts à {ville} et dans les environs. Parlez-nous de votre jardin.',
    services: ['Création de jardins', 'Entretien régulier', 'Taille de haies et d’arbres', 'Aménagements extérieurs'],
    cta: 'Demander un devis',
  },
  automobile: {
    id: 'automobile', label: 'Mécanique automobile', primary: '#22252b', accent: '#e4572e', art: 'car',
    tagline: 'Votre garage à {ville}',
    about: '{nom} prend en charge l’entretien et la réparation de votre véhicule à {ville}. Contactez-nous pour prendre rendez-vous.',
    services: ['Entretien et vidange', 'Freinage', 'Diagnostic', 'Pneumatiques'],
    cta: 'Prendre rendez-vous',
  },
  restauration: {
    id: 'restauration', label: 'Restauration', primary: '#7a2e2e', accent: '#e8b04b', art: 'plate',
    tagline: 'Bienvenue chez {nom}, à {ville}',
    about: '{nom} vous accueille à {ville}. Retrouvez ici nos informations pratiques et contactez-nous pour réserver.',
    services: ['Sur place', 'À emporter', 'Réservation de table', 'Groupes et événements'],
    cta: 'Réserver une table',
  },
  beaute: {
    id: 'beaute', label: 'Coiffure et esthétique', primary: '#6d3a5b', accent: '#e9b8c8', art: 'scissors',
    tagline: 'Votre salon à {ville}',
    about: '{nom} vous accueille à {ville}. Contactez-nous pour prendre rendez-vous.',
    services: ['Coupe et coiffage', 'Couleur', 'Soins', 'Conseils personnalisés'],
    cta: 'Prendre rendez-vous',
  },
  commerce: {
    id: 'commerce', label: 'Commerce de proximité', primary: '#2d4a3e', accent: '#e0a458', art: 'shop',
    tagline: '{nom}, votre commerce à {ville}',
    about: '{nom} vous accueille à {ville}. Retrouvez ici nos informations pratiques et nos coordonnées.',
    services: ['Nos produits', 'Commandes', 'Conseils', 'Informations pratiques'],
    cta: 'Nous contacter',
  },
  services: {
    id: 'services', label: 'Services locaux', primary: '#243b55', accent: '#5fa8d3', art: 'spark',
    tagline: '{nom}, à {ville} et alentours',
    about: '{nom} intervient à {ville} et dans les environs. Contactez-nous pour présenter votre besoin.',
    services: ['Prestation 1 (à compléter)', 'Prestation 2 (à compléter)', 'Prestation 3 (à compléter)'],
    cta: 'Nous contacter',
  },
};

const TRADE_SECTOR: Record<string, SectorId> = {
  plombier: 'plomberie', electricien: 'electricite', climaticien: 'climatisation', macon: 'maconnerie',
  couvreur: 'couverture', paysagiste: 'paysagisme', garage: 'automobile', restaurant: 'restauration',
  coiffeur: 'beaute', 'institut-beaute': 'beaute', boulangerie: 'commerce', boucherie: 'commerce',
  fleuriste: 'commerce', menuisier: 'maconnerie', peintre: 'maconnerie',
};

export const sectorFor = (trade: string): SectorId => TRADE_SECTOR[trade] ?? 'services';

// --- Contenu éditable --------------------------------------------------------------------

export interface MockupData {
  sector: SectorId;
  name: string;
  tagline: string;
  about: string;
  services: string[];
  /** Zone d'intervention (texte libre). */
  area: string;
  phone: string;
  email: string;
  address: string;
  /** Horaires : uniquement s'ils sont connus ou saisis. */
  hours: string;
  cta: string;
  primary: string;
  accent: string;
  art: ArtKey;
  sections: { about: boolean; services: boolean; area: boolean; hours: boolean; contact: boolean };
}

const HEX = /^#[0-9a-f]{6}$/i;
const LIMITS = { name: 80, tagline: 120, about: 1200, service: 80, services: 8, area: 300, phone: 30, email: 120, address: 200, hours: 400, cta: 40 };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(CONTROL, '').trim().slice(0, max) : '');

/** Valide et borne un contenu de maquette reçu du navigateur (jamais de HTML : tout est échappé au rendu). */
export function sanitizeData(input: unknown, fallback: MockupData): MockupData {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (o.sections && typeof o.sections === 'object' ? o.sections : {}) as Record<string, unknown>;
  const sector = typeof o.sector === 'string' && o.sector in SECTORS ? (o.sector as SectorId) : fallback.sector;
  const services = Array.isArray(o.services)
    ? o.services.map((x) => clean(x, LIMITS.service)).filter(Boolean).slice(0, LIMITS.services)
    : fallback.services;
  const email = clean(o.email, LIMITS.email);
  const bool = (k: keyof MockupData['sections']) => (typeof s[k] === 'boolean' ? (s[k] as boolean) : fallback.sections[k]);
  return {
    sector,
    name: clean(o.name, LIMITS.name) || fallback.name,
    tagline: clean(o.tagline, LIMITS.tagline),
    about: clean(o.about, LIMITS.about),
    services,
    area: clean(o.area, LIMITS.area),
    phone: clean(o.phone, LIMITS.phone),
    email: /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(email) ? email : '',
    address: clean(o.address, LIMITS.address),
    hours: clean(o.hours, LIMITS.hours),
    cta: clean(o.cta, LIMITS.cta) || fallback.cta,
    primary: typeof o.primary === 'string' && HEX.test(o.primary) ? o.primary : fallback.primary,
    accent: typeof o.accent === 'string' && HEX.test(o.accent) ? o.accent : fallback.accent,
    art: typeof o.art === 'string' && o.art in ART ? (o.art as ArtKey) : fallback.art,
    sections: { about: bool('about'), services: bool('services'), area: bool('area'), hours: bool('hours'), contact: bool('contact') },
  };
}

const fill = (tpl: string, v: { nom: string; ville: string }) => tpl.replaceAll('{nom}', v.nom).replaceAll('{ville}', v.ville);

/** Contenu initial à partir des données réelles du prospect débloqué. */
export function defaultData(p: Pick<PublicProspect, 'name' | 'trade' | 'city' | 'phone' | 'email' | 'address' | 'postal_code'>): MockupData {
  const sector = SECTORS[sectorFor(p.trade)];
  const ville = p.city ? titleCase(p.city) : 'votre ville';
  const v = { nom: p.name, ville };
  return {
    sector: sector.id,
    name: p.name,
    tagline: fill(sector.tagline, v),
    about: fill(sector.about, v),
    services: [...sector.services],
    area: p.city ? `${ville} et ses environs` : '',
    phone: p.phone ?? '',
    email: p.email ?? '',
    address: [p.address, [p.postal_code, p.city ? titleCase(p.city) : null].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    hours: '',
    cta: sector.cta,
    primary: sector.primary,
    accent: sector.accent,
    art: sector.art,
    sections: { about: true, services: true, area: true, hours: false, contact: true },
  };
}

// --- Rendu ---------------------------------------------------------------------------------

export interface Creator {
  name: string;
  email: string;
  phone: string | null;
}

/** Couleur de texte lisible sur un fond donné (contraste WCAG). */
export function textOn(hex: string): string {
  const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  return lum > 0.4 ? '#111111' : '#ffffff';
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

export function renderMockup(d: MockupData, creator: Creator): string {
  const on = textOn(d.primary);
  const creatorContact = [
    creator.email ? `<a href="mailto:${esc(creator.email)}?subject=${esc(encodeURIComponent(`Proposition de site pour ${d.name}`))}">Contacter ${esc(creator.name)}</a>` : '',
    creator.phone ? `<a href="${esc(telHref(creator.phone))}">${esc(creator.phone)}</a>` : '',
  ].filter(Boolean).join(' · ');
  const contactLines = [
    d.phone ? `<p><strong>Téléphone</strong><br><a href="${esc(telHref(d.phone))}">${esc(d.phone)}</a></p>` : '',
    d.email ? `<p><strong>Email</strong><br><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></p>` : '',
    d.address ? `<p><strong>Adresse</strong><br>${esc(d.address)}</p>` : '',
  ].join('');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: d.name,
    ...(d.phone ? { telephone: d.phone } : {}),
    ...(d.email ? { email: d.email } : {}),
    ...(d.address ? { address: d.address } : {}),
    ...(d.area ? { areaServed: d.area } : {}),
  };
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(d.name)}${d.tagline ? ` | ${esc(d.tagline)}` : ''}</title>
<meta name="description" content="${esc((d.about || d.tagline).slice(0, 155))}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>
:root{--p:${d.primary};--a:${d.accent};--on:${on};--on-a:${textOn(d.accent)}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;line-height:1.6;background:#fafaf7}
a{color:var(--p)}.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.proposal{background:#1d1d1f;color:#fff;font-size:.85rem;padding:8px 0}.proposal .wrap{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;align-items:center}.proposal a{color:#fff;font-weight:600}
header.top{background:#fff;border-bottom:1px solid #e7e5df}header.top .wrap{display:flex;justify-content:space-between;align-items:center;min-height:64px;gap:12px}
.brand{font-weight:800;font-size:1.15rem;color:#1d1d1f;text-decoration:none}
.btn{display:inline-block;background:var(--a);color:var(--on-a);padding:12px 20px;border-radius:10px;font:inherit;font-weight:700;text-decoration:none;border:0;cursor:pointer;white-space:nowrap}
.brand{min-width:0;overflow-wrap:anywhere}
.btn[disabled]{opacity:.7;cursor:not-allowed}
.hero{background:var(--p);color:var(--on);padding:64px 0}.hero .wrap{display:grid;grid-template-columns:1.4fr 1fr;gap:32px;align-items:center}
.hero h1{font-size:clamp(1.8rem,4.5vw,2.8rem);line-height:1.15;margin:0 0 12px}.hero p{font-size:1.1rem;margin:0 0 24px;opacity:.92}
.hero svg{width:100%;max-width:260px;justify-self:center;fill:none;stroke:var(--a);stroke-width:6;stroke-linecap:round;stroke-linejoin:round}
section{padding:56px 0}section h2{font-size:1.6rem;margin:0 0 16px;color:var(--p)}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;padding:0;list-style:none;margin:0}
.services li{background:#fff;border:1px solid #e7e5df;border-left:5px solid var(--a);border-radius:10px;padding:18px;font-weight:600}
.alt{background:#fff}.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px}
form{display:grid;gap:12px}label{display:grid;gap:4px;font-weight:600;font-size:.95rem}input,textarea{font:inherit;padding:10px 12px;border:1.5px solid #d7d3ca;border-radius:8px;background:#fff}
.demo-note{font-size:.85rem;color:#5f5f5f;margin:0}.hours{white-space:pre-line}
footer{background:#1d1d1f;color:#d6d6d6;padding:28px 0;font-size:.85rem}
@media (max-width:760px){.hero .wrap,.contact-grid{grid-template-columns:1fr}.hero svg{max-width:150px}.hero{padding:44px 0}}
</style>
</head>
<body>
<div class="proposal" role="note"><div class="wrap"><span>Proposition de site réalisée par ${esc(creator.name)}, <strong>non officielle</strong> : ce n’est pas le site de ${esc(d.name)}.</span>${creatorContact ? `<span>${creatorContact}</span>` : ''}</div></div>
<header class="top"><div class="wrap"><a class="brand" href="#accueil">${esc(d.name)}</a>${d.phone ? `<a class="btn" href="${esc(telHref(d.phone))}">${esc(d.phone)}</a>` : `<a class="btn" href="#contact">${esc(d.cta)}</a>`}</div></header>
<main>
<div class="hero" id="accueil"><div class="wrap"><div><h1>${esc(d.tagline || d.name)}</h1>${d.area ? `<p>${esc(d.area)}</p>` : ''}<a class="btn" href="#contact">${esc(d.cta)}</a></div><svg viewBox="0 0 120 120" aria-hidden="true">${ART[d.art]}</svg></div></div>
${d.sections.about && d.about ? `<section id="presentation"><div class="wrap"><h2>Présentation</h2><p>${esc(d.about)}</p></div></section>` : ''}
${d.sections.services && d.services.length ? `<section class="alt" id="prestations"><div class="wrap"><h2>Prestations</h2><ul class="services">${d.services.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></section>` : ''}
${d.sections.area && d.area ? `<section id="zone"><div class="wrap"><h2>Zone d’intervention</h2><p>${esc(d.area)}</p></div></section>` : ''}
${d.sections.hours && d.hours ? `<section class="alt" id="horaires"><div class="wrap"><h2>Horaires</h2><p class="hours">${esc(d.hours)}</p></div></section>` : ''}
${d.sections.contact ? `<section id="contact"><div class="wrap"><h2>Contact</h2><div class="contact-grid"><div>${contactLines || '<p>Coordonnées à compléter.</p>'}</div>
<form aria-describedby="demo-note"><label>Nom<input name="n" autocomplete="off"></label><label>Téléphone ou email<input name="c" autocomplete="off"></label><label>Votre demande<textarea name="m" rows="4"></textarea></label><button class="btn" type="button" disabled>${esc(d.cta)}</button><p class="demo-note" id="demo-note">Formulaire de démonstration : aucun message n’est envoyé depuis cette maquette.</p></form></div></div></section>` : ''}
</main>
<footer><div class="wrap">${esc(d.name)} · Maquette de démonstration, non officielle, réalisée par ${esc(creator.name)}.</div></footer>
</body>
</html>`;
}

/** Page affichée quand le lien a expiré, a été révoqué ou n'existe pas. */
export function unavailablePage(state: 'expired' | 'revoked' | 'missing'): string {
  const msg =
    state === 'expired' ? 'Cette proposition de site a expiré.' : state === 'revoked' ? 'Cette proposition de site n’est plus disponible.' : 'Cette page n’existe pas.';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Proposition indisponible</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafaf7;color:#1d1d1f;padding:20px;text-align:center}</style></head>
<body><main><h1>${esc(msg)}</h1><p>Contactez la personne qui vous l’a envoyée pour obtenir un nouveau lien.</p></main></body></html>`;
}

// --- Stockage ------------------------------------------------------------------------------

export interface MockupRow {
  id: string;
  user_id: number;
  prospect_id: string;
  data: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  revoked_at: string | null;
  views: number;
  last_viewed_at: string | null;
}

export const EXPIRY_DAYS = [7, 30, 90] as const;

/** Identifiant de 128 bits en base64url : impossible à deviner, sert aussi d'URL de partage. */
const newId = () => randomBytes(16).toString('base64url');

export function mockupQuota(db: DB, u: UserRow, now = new Date()): { limit: number; used: number; remaining: number } {
  const plan = effectivePlan(u);
  const since = plan.monthly ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() : '0000';
  const used = Number((db.prepare('SELECT COUNT(*) AS n FROM mockup_events WHERE user_id = ? AND created_at >= ?').get(u.id, since) as { n: number }).n);
  return { limit: plan.mockups, used, remaining: Math.max(0, plan.mockups - used) };
}

export type CreateResult = { ok: true; mockup: MockupRow } | { ok: false; reason: 'quota' };

export function createMockup(db: DB, u: UserRow, lead: PublicProspect, days = 30): CreateResult {
  if (mockupQuota(db, u).remaining <= 0) return { ok: false, reason: 'quota' };
  const now = nowIso();
  const id = newId();
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  db.prepare('INSERT INTO mockups (id, user_id, prospect_id, data, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, u.id, lead.id, JSON.stringify(defaultData(lead)), now, now, expires,
  );
  // Journal séparé : supprimer une maquette ne rend pas le quota consommé.
  db.prepare('INSERT INTO mockup_events (user_id, created_at) VALUES (?, ?)').run(u.id, now);
  return { ok: true, mockup: getMockup(db, u.id, id)! };
}

export const getMockup = (db: DB, userId: number, id: string): MockupRow | null =>
  (db.prepare('SELECT * FROM mockups WHERE id = ? AND user_id = ?').get(id, userId) as MockupRow | undefined) ?? null;

export const listMockups = (db: DB, userId: number, prospectId?: string): MockupRow[] =>
  (prospectId
    ? db.prepare('SELECT * FROM mockups WHERE user_id = ? AND prospect_id = ? ORDER BY created_at DESC').all(userId, prospectId)
    : db.prepare('SELECT * FROM mockups WHERE user_id = ? ORDER BY updated_at DESC').all(userId)) as unknown as MockupRow[];

export function updateMockup(db: DB, userId: number, id: string, patch: { data?: unknown; expiresInDays?: unknown }): MockupRow | null {
  const cur = getMockup(db, userId, id);
  if (!cur) return null;
  const data = patch.data === undefined ? cur.data : JSON.stringify(sanitizeData(patch.data, parseData(cur)));
  let expires = cur.expires_at;
  if (typeof patch.expiresInDays === 'number' && (EXPIRY_DAYS as readonly number[]).includes(patch.expiresInDays)) {
    expires = new Date(Date.now() + patch.expiresInDays * 86_400_000).toISOString();
  }
  db.prepare('UPDATE mockups SET data = ?, expires_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(data, expires, nowIso(), id, userId);
  return getMockup(db, userId, id);
}

/** Révocation : le lien cesse de fonctionner immédiatement ; il peut être réactivé. */
export function setRevoked(db: DB, userId: number, id: string, revoked: boolean): MockupRow | null {
  if (!getMockup(db, userId, id)) return null;
  const now = nowIso();
  db.prepare('UPDATE mockups SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(revoked ? now : null, now, id, userId);
  return getMockup(db, userId, id);
}

export const deleteMockup = (db: DB, userId: number, id: string): boolean =>
  Number(db.prepare('DELETE FROM mockups WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;

export function parseData(m: Pick<MockupRow, 'data'>): MockupData {
  const fallback = defaultData({ name: 'Entreprise', trade: '', city: null, phone: null, email: null, address: null, postal_code: null });
  try {
    return sanitizeData(JSON.parse(m.data), fallback);
  } catch {
    return fallback;
  }
}

export type PublicState = 'ok' | 'expired' | 'revoked' | 'missing';

/** Maquette consultée par le prospect via son lien (sans compte). */
export function publicMockup(db: DB, id: string): { state: PublicState; row?: MockupRow } {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return { state: 'missing' };
  const row = db.prepare('SELECT * FROM mockups WHERE id = ?').get(id) as MockupRow | undefined;
  if (!row) return { state: 'missing' };
  if (row.revoked_at) return { state: 'revoked', row };
  if (Date.parse(row.expires_at) < Date.now()) return { state: 'expired', row };
  return { state: 'ok', row };
}

export function countView(db: DB, id: string): void {
  db.prepare('UPDATE mockups SET views = views + 1, last_viewed_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Vue d'une maquette pour l'API (propriétaire uniquement). */
export function mockupView(m: MockupRow, appUrl: string) {
  const expired = Date.parse(m.expires_at) < Date.now();
  return {
    id: m.id,
    prospect_id: m.prospect_id,
    data: parseData(m),
    url: `${appUrl}/p/${m.id}`,
    created_at: m.created_at,
    updated_at: m.updated_at,
    expires_at: m.expires_at,
    revoked: Boolean(m.revoked_at),
    expired,
    active: !m.revoked_at && !expired,
    views: m.views,
    last_viewed_at: m.last_viewed_at,
  };
}

export const sectorsForClient = () =>
  Object.values(SECTORS).map((s) => ({ id: s.id, label: s.label, primary: s.primary, accent: s.accent, art: s.art, cta: s.cta, services: s.services }));
