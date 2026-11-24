// Pages publiques rendues côté serveur (HTML complet, rapide, indexable) :
// accueil, tarifs, pages par ville, par métier et ville × métier, pages légales,
// sitemap et robots. Aucune coordonnée de prospect n'est publiée : seulement des agrégats.

import { FREE_UNLOCKS, PLANS } from './billing.ts';
import { CITIES, TRADES, type City, type Trade } from './catalog.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmt = (n: number) => n.toLocaleString('fr-FR');
const BRAND = 'Sitolead';
export const TAGLINE = 'Vous créez des sites, on vous trouve les clients';

export interface Stats {
  total: number;
  nosite: number;
  weak: number;
  byTrade: { trade: string; n: number; nosite: number }[];
}

export interface PageOpts {
  title: string;
  description: string;
  path: string;
  body: string;
  jsonLd?: object[];
  noindex?: boolean;
}

export function layout(appUrl: string, o: PageOpts): string {
  const url = appUrl + o.path;
  const ld = (o.jsonLd ?? []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
${o.noindex ? '<meta name="robots" content="noindex, follow">' : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="fr_FR">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#14231f">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/style.css">
${ld}
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header class="site-header">
  <div class="wrap nav">
    <a class="logo" href="/"><span class="logo-mark" aria-hidden="true">S</span>${BRAND}</a>
    <nav aria-label="Navigation principale">
      <a href="/#comment" class="hide-sm">Comment ça marche</a>
      <a href="/tarifs">Tarifs</a>
      <a href="/prospection" class="hide-sm">Villes</a>
      <a href="/app">Connexion</a>
      <a href="/app#inscription" class="btn btn-sm">Essai gratuit</a>
    </nav>
  </div>
</header>
<main id="contenu">
${o.body}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <a class="logo" href="/"><span class="logo-mark" aria-hidden="true">S</span>${BRAND}</a>
      <p class="muted">${TAGLINE}. Prospection d’entreprises sans site ou avec un site à refaire, partout en France.</p>
    </div>
    <div>
      <h2 class="footer-title">Produit</h2>
      <a href="/#comment">Comment ça marche</a>
      <a href="/tarifs">Tarifs</a>
      <a href="/app#inscription">Créer un compte</a>
    </div>
    <div>
      <h2 class="footer-title">Prospection</h2>
      ${CITIES.slice(0, 6).map((c) => `<a href="/prospection/${c.slug}">Clients à ${esc(c.name)}</a>`).join('')}
      <a href="/prospection">Toutes les villes</a>
    </div>
    <div>
      <h2 class="footer-title">Légal</h2>
      <a href="/mentions-legales">Mentions légales</a>
      <a href="/cgv">Conditions générales</a>
      <a href="/confidentialite">Confidentialité</a>
    </div>
  </div>
  <div class="wrap muted small footer-base">© ${new Date().getFullYear()} ${BRAND}. Données : OpenStreetMap (ODbL), Annuaire des entreprises (Etalab).</div>
</footer>
</body>
</html>`;
}

// --- Blocs réutilisables -------------------------------------------------------------

const cta = (label = `Trouver mes ${FREE_UNLOCKS} premiers clients gratuitement`) =>
  `<a class="btn btn-lg" href="/app#inscription">${esc(label)}</a>`;

function pricingCards(): string {
  return `<div class="plans">${Object.values(PLANS)
    .map(
      (p) => `<article class="plan${p.id === 'pro' ? ' plan-featured' : ''}">
  ${p.id === 'pro' ? '<p class="plan-flag">Le plus choisi</p>' : ''}
  <h3>${esc(p.name)}</h3>
  <p class="price"><strong>${p.priceEur} €</strong>${p.monthly ? '<span> HT / mois</span>' : '<span> pour toujours</span>'}</p>
  <ul class="checks">${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
  <a class="btn${p.id === 'pro' ? '' : ' btn-ghost'}" href="/app#inscription">${p.id === 'free' ? 'Commencer gratuitement' : `Choisir ${esc(p.name)}`}</a>
  <p class="small muted">${p.monthly ? 'Sans engagement, résiliable en 1 clic.' : 'Sans carte bancaire.'}</p>
</article>`,
    )
    .join('')}</div>`;
}

const FAQ: [string, string][] = [
  [
    'D’où viennent les entreprises proposées ?',
    'De sources publiques et officielles : OpenStreetMap (commerces et artisans avec leurs coordonnées) et l’Annuaire des entreprises de l’État (registre SIRENE, entreprises créées récemment). Les listes sont mises à jour chaque semaine.',
  ],
  [
    'Comment savez-vous qu’une entreprise a besoin d’un site ?',
    'Nous vérifions si elle a un site, seulement une page Facebook ou Instagram, ou un site hors service. Quand un site existe, nous l’auditons : HTTPS, compatibilité mobile, vitesse, référencement, date de dernière mise à jour, formulaire de contact. Chaque prospect reçoit un score d’opportunité sur 100.',
  ],
  [
    'Qu’est-ce que je reçois quand je débloque une entreprise ?',
    'Son nom, son adresse, son téléphone et son email quand ils sont publics, son SIRET, l’audit détaillé de son site, et trois messages de prospection personnalisés (email, script d’appel, SMS) prêts à envoyer.',
  ],
  [
    'Est-ce vraiment gratuit pour commencer ?',
    `Oui. Les ${FREE_UNLOCKS} premières entreprises sont offertes, sans carte bancaire. Ensuite, l’abonnement Pro à ${PLANS.pro.priceEur} € HT par mois donne accès à ${PLANS.pro.unlocks} entreprises chaque mois.`,
  ],
  [
    'Puis-je résilier quand je veux ?',
    'Oui, en un clic depuis votre espace, sans engagement. Votre abonnement reste actif jusqu’à la fin de la période payée et vous gardez vos prospects déjà débloqués.',
  ],
  [
    'Est-ce conforme au RGPD de prospecter ces entreprises ?',
    'La prospection B2B par email est autorisée en France si le message concerne l’activité professionnelle du destinataire et lui permet de refuser facilement. Nos modèles incluent cette mention de désinscription. Ne contactez que les adresses professionnelles et respectez les refus.',
  ],
];

function faqBlock(): { html: string; ld: object } {
  return {
    html: `<section class="section wrap narrow" id="faq"><h2>Questions fréquentes</h2>${FAQ.map(
      ([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`,
    ).join('')}</section>`,
    ld: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
  };
}

function breadcrumb(appUrl: string, items: [string, string][]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: appUrl + path })),
  };
}

const crumbs = (items: [string, string][]) =>
  `<nav class="crumbs wrap" aria-label="Fil d’Ariane">${items
    .map(([n, p], i) => (i === items.length - 1 ? `<span aria-current="page">${esc(n)}</span>` : `<a href="${p}">${esc(n)}</a>`))
    .join(' <span aria-hidden="true">›</span> ')}</nav>`;

function sampleCard(): string {
  return `<figure class="sample" aria-label="Exemple de fiche prospect">
  <div class="sample-head">
    <div><p class="sample-name">Plomberie M•••••••</p><p class="muted small">Plombier · Annecy · créée il y a 4 mois</p></div>
    <div class="score score-hot" title="Score d’opportunité">92</div>
  </div>
  <p><span class="tag tag-hot">Aucun site</span> <span class="tag">Téléphone</span> <span class="tag">Email</span></p>
  <ul class="issues">
    <li>Introuvable sur « plombier Annecy »</li>
    <li>Seulement une fiche annuaire</li>
    <li>Entreprise récente : besoin de visibilité</li>
  </ul>
  <div class="sample-pitch"><p class="small muted">Email prêt à envoyer</p><p>« Bonjour, en cherchant « plombier à Annecy » sur Google, je n’ai trouvé aucun site pour votre entreprise… »</p></div>
  <figcaption class="small muted">Exemple de fiche, nom masqué avant déblocage.</figcaption>
</figure>`;
}

// --- Pages ---------------------------------------------------------------------------

export function homePage(appUrl: string, totals: { prospects: number; nosite: number }): string {
  const faq = faqBlock();
  const proof =
    totals.prospects >= 100
      ? `<p class="proof"><strong>${fmt(totals.prospects)}</strong> entreprises analysées, dont <strong>${fmt(totals.nosite)}</strong> sans vrai site.</p>`
      : '';
  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div>
      <p class="eyebrow">Pour les freelances et agences web</p>
      <h1>Vous créez des sites.<br><span class="accent">On vous trouve les clients.</span></h1>
      <p class="lead">${BRAND} repère les artisans, commerces et indépendants de votre ville <strong>sans site</strong> ou avec un <strong>site à refaire</strong>, vous donne leurs coordonnées et écrit le message pour les décrocher.</p>
      <div class="hero-cta">${cta()}<a class="btn btn-ghost btn-lg" href="#comment">Voir comment ça marche</a></div>
      <p class="small muted">${FREE_UNLOCKS} entreprises offertes · Sans carte bancaire · Prêt en 2 minutes</p>
      ${proof}
    </div>
    ${sampleCard()}
  </div>
</section>

<section class="section wrap" id="comment">
  <h2>De « je cherche des clients » à « devis signé » en 3 étapes</h2>
  <ol class="steps">
    <li><h3>Choisissez une ville et un métier</h3><p>Plombiers à Lyon, restaurants à Nantes, coiffeurs à Annecy : ${TRADES.length} métiers et toutes les communes de France.</p></li>
    <li><h3>On trie les meilleures opportunités</h3><p>Pas de site, simple page Facebook, site en panne ou daté : chaque entreprise est auditée et notée sur 100.</p></li>
    <li><h3>Vous contactez avec le bon message</h3><p>Coordonnées, audit à montrer au client, email, script d’appel et SMS personnalisés. Il ne reste qu’à envoyer.</p></li>
  </ol>
</section>

<section class="section band">
  <div class="wrap">
    <h2>Tout ce qu’il faut pour vendre des sites, au même endroit</h2>
    <div class="features">
      <article><h3>Entreprises sans site</h3><p>Commerces et artisans actifs, sans site ou cachés derrière une page Facebook ou un annuaire.</p></article>
      <article><h3>Audit de site automatique</h3><p>HTTPS, mobile, vitesse, titre Google, données structurées, dernière mise à jour : la liste des problèmes, en français, à montrer au prospect.</p></article>
      <article><h3>Entreprises tout juste créées</h3><p>Les créations du registre SIRENE : des gérants qui ont besoin d’un site maintenant.</p></article>
      <article><h3>Score d’opportunité</h3><p>Une note sur 100 qui combine l’état du site, l’âge de l’entreprise et les contacts disponibles, pour appeler les meilleurs en premier.</p></article>
      <article><h3>Messages prêts à envoyer</h3><p>Email, script d’appel avec réponses aux objections, SMS : rédigés pour chaque entreprise, avec votre signature.</p></article>
      <article><h3>Suivi commercial</h3><p>À contacter, relancé, rendez-vous, devis, gagné : vos prospects et vos relances dans un pipeline simple, exportable en CSV.</p></article>
    </div>
  </div>
</section>

<section class="section wrap">
  <h2>Un seul client signé rembourse des mois d’abonnement</h2>
  <div class="roi">
    <div><p class="big">${PLANS.pro.priceEur} €</p><p class="muted">Par mois pour ${PLANS.pro.unlocks} entreprises qualifiées</p></div>
    <div><p class="big">1 000 à 2 000 €</p><p class="muted">Le prix courant d’un site vitrine pour un artisan</p></div>
    <div><p class="big">1 sur ${PLANS.pro.unlocks}</p><p class="muted">Un seul client signé par mois suffit pour être rentable</p></div>
  </div>
</section>

<section class="section wrap" id="tarifs">
  <h2>Des tarifs simples</h2>
  <p class="lead">Commencez avec ${FREE_UNLOCKS} entreprises offertes. Passez à l’abonnement quand vous avez signé votre premier client.</p>
  ${pricingCards()}
</section>

<section class="section wrap">
  <h2>Trouvez des clients dans votre ville</h2>
  <div class="link-grid">${CITIES.map((c) => `<a href="/prospection/${c.slug}">${esc(c.name)}</a>`).join('')}</div>
  <h2 class="mt">Trouvez des clients par métier</h2>
  <div class="link-grid">${TRADES.map((t) => `<a href="/metiers/${t.slug}">Sites pour ${esc(t.plural)}</a>`).join('')}</div>
</section>

${faq.html}

<section class="section final-cta">
  <div class="wrap narrow center">
    <h2>Vos ${FREE_UNLOCKS} premiers prospects vous attendent</h2>
    <p class="lead">Créez votre compte, choisissez votre ville, et contactez votre premier client dans les 10 minutes.</p>
    ${cta('Créer mon compte gratuit')}
  </div>
</section>`;

  return layout(appUrl, {
    // Mot-clé en tête, marque à la fin, moins de 60 caractères : c'est ce que Google affiche.
    title: `Trouver des clients pour votre agence web | ${BRAND}`,
    // Moins de 160 caractères pour ne pas être coupée dans les résultats Google.
    description: `Vous créez des sites ? ${BRAND} trouve les entreprises sans site ou au site à refaire près de chez vous : coordonnées, audit, messages prêts. ${FREE_UNLOCKS} offertes.`,
    path: '/',
    body,
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'Organization', name: BRAND, url: appUrl, logo: `${appUrl}/assets/favicon.svg` },
      { '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND, url: appUrl, inLanguage: 'fr-FR' },
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: BRAND,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: TAGLINE,
        offers: Object.values(PLANS).map((p) => ({ '@type': 'Offer', name: p.name, price: String(p.priceEur), priceCurrency: 'EUR' })),
      },
      faq.ld,
    ],
  });
}

export function pricingPage(appUrl: string): string {
  const faq = faqBlock();
  const plans = Object.values(PLANS);
  const body = `
${crumbs([['Accueil', '/'], ['Tarifs', '/tarifs']])}
<section class="section wrap">
  <h1>Tarifs</h1>
  <p class="lead">${FREE_UNLOCKS} entreprises offertes pour essayer. Ensuite, un abonnement mensuel sans engagement.</p>
  ${pricingCards()}
  <div class="table-scroll">
  <table class="compare">
    <caption>Comparatif des offres</caption>
    <thead><tr><th scope="col">Inclus</th>${plans.map((p) => `<th scope="col">${esc(p.name)}</th>`).join('')}</tr></thead>
    <tbody>
      <tr><th scope="row">Entreprises débloquées</th>${plans.map((p) => `<td>${fmt(p.unlocks)}${p.monthly ? ' / mois' : ' au total'}</td>`).join('')}</tr>
      <tr><th scope="row">Recherche par ville et métier</th>${plans.map(() => '<td>Oui</td>').join('')}</tr>
      <tr><th scope="row">Audit de site</th>${plans.map(() => '<td>Oui</td>').join('')}</tr>
      <tr><th scope="row">Email, appel, SMS personnalisés</th>${plans.map(() => '<td>Oui</td>').join('')}</tr>
      <tr><th scope="row">Pipeline et relances</th>${plans.map(() => '<td>Oui</td>').join('')}</tr>
      <tr><th scope="row">Export CSV</th>${plans.map((p) => `<td>${p.csv ? 'Oui' : 'Non'}</td>`).join('')}</tr>
      <tr><th scope="row">Support</th>${plans.map((p) => `<td>${p.id === 'agence' ? 'Prioritaire' : 'Email'}</td>`).join('')}</tr>
    </tbody>
  </table>
  </div>
  <p class="small muted">Prix hors taxes. Paiement sécurisé par Stripe. Facture disponible chaque mois dans votre espace.</p>
</section>
${faq.html}`;
  return layout(appUrl, {
    title: `Tarifs ${BRAND} : ${FREE_UNLOCKS} prospects offerts, puis dès ${PLANS.pro.priceEur} € / mois`,
    description: `Essayez ${BRAND} avec ${FREE_UNLOCKS} entreprises offertes. Abonnement Pro à ${PLANS.pro.priceEur} € HT / mois pour ${PLANS.pro.unlocks} prospects qualifiés, sans engagement.`,
    path: '/tarifs',
    body,
    jsonLd: [breadcrumb(appUrl, [['Accueil', '/'], ['Tarifs', '/tarifs']]), faq.ld],
  });
}

export function citiesIndexPage(appUrl: string): string {
  const body = `
${crumbs([['Accueil', '/'], ['Villes', '/prospection']])}
<section class="section wrap">
  <h1>Trouver des clients pour vos sites, ville par ville</h1>
  <p class="lead">Choisissez votre ville pour voir combien d’entreprises locales n’ont pas de site, ou un site à refaire. Toutes les autres communes de France sont disponibles dans l’application.</p>
  <div class="link-grid">${CITIES.map((c) => `<a href="/prospection/${c.slug}">${esc(c.name)} <span class="muted">(${c.dep})</span></a>`).join('')}</div>
  <p class="mt">${cta('Chercher dans ma commune')}</p>
</section>`;
  return layout(appUrl, {
    title: `Prospection web par ville : entreprises sans site près de chez vous | ${BRAND}`,
    description: `Trouvez des entreprises sans site internet dans ${CITIES.length} grandes villes et toutes les communes de France. Coordonnées, audit et messages prêts à envoyer.`,
    path: '/prospection',
    body,
    jsonLd: [breadcrumb(appUrl, [['Accueil', '/'], ['Villes', '/prospection']])],
  });
}

function statsBlock(s: Stats | null, where: string): string {
  if (!s || s.total === 0) {
    return `<div class="stats-empty"><p>L’analyse des entreprises ${esc(where)} démarre à la première recherche. Créez votre compte pour voir les résultats en quelques secondes.</p></div>`;
  }
  return `<div class="stats">
  <div><p class="big">${fmt(s.total)}</p><p class="muted">entreprises analysées ${esc(where)}</p></div>
  <div><p class="big">${fmt(s.nosite)}</p><p class="muted">sans vrai site internet</p></div>
  <div><p class="big">${fmt(s.weak)}</p><p class="muted">avec un site à refaire</p></div>
</div>`;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function cityPage(appUrl: string, city: City, stats: Stats | null): string {
  const where = `à ${city.name}`;
  const tradeLinks = TRADES.map((t) => {
    const n = stats?.byTrade.find((b) => b.trade === t.slug);
    return `<a href="/prospection/${city.slug}/${t.slug}">${esc(cap(t.plural))}${n ? ` <span class="muted">· ${fmt(n.nosite)} sans site</span>` : ''}</a>`;
  }).join('');
  const others = CITIES.filter((c) => c.slug !== city.slug && (c.dep === city.dep || CITIES.indexOf(c) < 8)).slice(0, 8);
  const path = `/prospection/${city.slug}`;
  const body = `
${crumbs([['Accueil', '/'], ['Villes', '/prospection'], [city.name, path]])}
<section class="section wrap">
  <h1>Trouver des clients pour votre agence web ${esc(where)}</h1>
  <p class="lead">Artisans, commerçants et indépendants ${esc(where)} qui n’ont pas de site, ou un site qui leur fait perdre des clients. Débloquez leurs coordonnées et contactez-les avec un message personnalisé.</p>
  ${statsBlock(stats, where)}
  <p>${cta(`Voir les prospects ${where}`)}</p>
</section>
<section class="section wrap">
  <h2>Prospects ${esc(where)} par métier</h2>
  <div class="link-grid">${tradeLinks}</div>
</section>
<section class="section wrap narrow">
  <h2>Pourquoi prospecter ${esc(where)} ?</h2>
  <p>Les entreprises locales sont les clients les plus accessibles pour un créateur de sites : vous pouvez les rencontrer, elles cherchent un prestataire de confiance près de chez elles, et un site vitrine change concrètement leur chiffre d’affaires. ${BRAND} repère pour vous celles ${esc(where)} qui en ont le plus besoin, avec un audit chiffré à leur montrer.</p>
  <h3>Autres villes</h3>
  <div class="link-grid">${others.map((c) => `<a href="/prospection/${c.slug}">${esc(c.name)}</a>`).join('')}</div>
</section>`;
  return layout(appUrl, {
    title: `Clients pour agence web ${where} : entreprises sans site | ${BRAND}`,
    description: stats?.total
      ? `${fmt(stats.nosite)} entreprises ${where} sans vrai site et ${fmt(stats.weak)} avec un site à refaire. Coordonnées, audit et messages de prospection prêts. ${FREE_UNLOCKS} offertes.`
      : `Trouvez les entreprises ${where} sans site internet ou avec un site à refaire : coordonnées, audit et messages de prospection prêts. ${FREE_UNLOCKS} prospects offerts.`,
    path,
    body,
    jsonLd: [breadcrumb(appUrl, [['Accueil', '/'], ['Villes', '/prospection'], [city.name, path]])],
  });
}

export function tradePage(appUrl: string, trade: Trade): string {
  const path = `/metiers/${trade.slug}`;
  const lbl = trade.label.toLowerCase();
  const body = `
${crumbs([['Accueil', '/'], [`Sites pour ${trade.plural}`, path]])}
<section class="section wrap">
  <h1>Vendre des sites internet aux ${esc(trade.plural)}</h1>
  <p class="lead">Les ${esc(trade.plural)} sans site perdent chaque jour des clients au profit de leurs concurrents. ${BRAND} vous les trouve, ville par ville, et vous donne les arguments pour les convaincre.</p>
  <p>${cta(`Trouver des ${trade.plural} sans site`)}</p>
</section>
<section class="section wrap narrow">
  <h2>L’argument qui fait mouche</h2>
  <p>Pour un professionnel de ce secteur (${esc(lbl)}), un site sert d’abord à <strong>${esc(trade.benefit)}</strong>. C’est l’angle de chaque message que ${BRAND} rédige pour vous, avec les problèmes précis relevés sur son site actuel quand il en a un.</p>
  <h2>Ce que vous obtenez pour chaque prospect</h2>
  <ul class="checks">
    <li>Nom, adresse, téléphone et email quand ils sont publics</li>
    <li>État de sa présence en ligne : aucun site, page Facebook, site en panne ou daté</li>
    <li>Audit détaillé de son site, prêt à lui montrer</li>
    <li>Email, script d’appel et SMS personnalisés</li>
  </ul>
</section>
<section class="section wrap">
  <h2>${esc(cap(trade.plural))} : prospects par ville</h2>
  <div class="link-grid">${CITIES.map((c) => `<a href="/prospection/${c.slug}/${trade.slug}">${esc(cap(trade.plural))} à ${esc(c.name)}</a>`).join('')}</div>
</section>`;
  return layout(appUrl, {
    title: `Trouver des ${trade.plural} sans site internet à démarcher | ${BRAND}`,
    description: `Vous créez des sites ? Trouvez les ${trade.plural} sans site ou avec un site dépassé près de chez vous, avec coordonnées, audit et messages prêts à envoyer.`,
    path,
    body,
    jsonLd: [breadcrumb(appUrl, [['Accueil', '/'], [`Sites pour ${trade.plural}`, path]])],
  });
}

export function cityTradePage(appUrl: string, city: City, trade: Trade, stats: Stats | null): string {
  const t = stats?.byTrade.find((b) => b.trade === trade.slug);
  const where = `à ${city.name}`;
  const path = `/prospection/${city.slug}/${trade.slug}`;
  const numbers =
    t && t.n > 0
      ? `<div class="stats"><div><p class="big">${fmt(t.n)}</p><p class="muted">${esc(trade.plural)} analysés ${esc(where)}</p></div><div><p class="big">${fmt(t.nosite)}</p><p class="muted">sans vrai site internet</p></div></div>`
      : statsBlock(null, where);
  const body = `
${crumbs([['Accueil', '/'], [city.name, `/prospection/${city.slug}`], [cap(trade.plural), path]])}
<section class="section wrap">
  <h1>${esc(cap(trade.plural))} sans site internet ${esc(where)}</h1>
  <p class="lead">La liste des ${esc(trade.plural)} ${esc(where)} à qui proposer un site : sans site, avec seulement une page Facebook, ou avec un site qui les dessert. Coordonnées, audit et messages prêts à envoyer.</p>
  ${numbers}
  <p>${cta(`Voir les ${trade.plural} ${where}`)}</p>
</section>
<section class="section wrap narrow">
  <h2>Comment convaincre ces prospects ${esc(where)}</h2>
  <p>Montrez-leur ce qu’ils perdent : quand un habitant tape « ${esc(trade.label.toLowerCase())} ${esc(city.name)} » sur Google, ce sont leurs concurrents qui apparaissent. Un site rapide et bien référencé leur permet de ${esc(trade.benefit)}. ${BRAND} rédige ce message pour vous, avec le nom de l’entreprise et les défauts précis de son site actuel.</p>
  <p><a href="/metiers/${trade.slug}">Tous les ${esc(trade.plural)}</a> · <a href="/prospection/${city.slug}">Tous les métiers ${esc(where)}</a></p>
</section>`;
  return layout(appUrl, {
    title: `${cap(trade.plural)} sans site ${where} : prospects pour créateurs de sites | ${BRAND}`,
    description: t?.n
      ? `${fmt(t.nosite)} ${trade.plural} ${where} sans vrai site sur ${fmt(t.n)} analysés. Coordonnées, audit et messages de prospection prêts.`
      : `Trouvez les ${trade.plural} ${where} sans site internet ou avec un site à refaire, avec coordonnées et messages de prospection prêts.`,
    path,
    body,
    // Sans données, la page serait du contenu mince : accessible mais non indexée.
    noindex: !t || t.n < 3,
    jsonLd: [breadcrumb(appUrl, [['Accueil', '/'], [city.name, `/prospection/${city.slug}`], [cap(trade.plural), path]])],
  });
}

// --- Pages légales -------------------------------------------------------------------

function legal(appUrl: string, path: string, title: string, content: string): string {
  return layout(appUrl, {
    title: `${title} | ${BRAND}`,
    description: `${title} du service ${BRAND}.`,
    path,
    body: `${crumbs([['Accueil', '/'], [title, path]])}<section class="section wrap narrow prose"><h1>${esc(title)}</h1>${content}</section>`,
  });
}

const legalContact = () => esc(process.env.LEGAL_CONTACT ?? 'contact@exemple.fr');

export function legalNoticePage(appUrl: string): string {
  const c = legalContact();
  return legal(appUrl, '/mentions-legales', 'Mentions légales', `
<p><strong>Éditeur :</strong> ${esc(process.env.LEGAL_NAME ?? BRAND)}. Contact : <a href="mailto:${c}">${c}</a>.</p>
<p><strong>Hébergement :</strong> communiqué sur simple demande à l’adresse ci-dessus.</p>
<p><strong>Données :</strong> les informations sur les entreprises proviennent de sources publiques : OpenStreetMap (© contributeurs OpenStreetMap, licence ODbL) et l’Annuaire des entreprises (données SIRENE, Etalab, Licence Ouverte 2.0).</p>
<p>Toute entreprise peut demander la suppression de sa fiche en écrivant à <a href="mailto:${c}">${c}</a>.</p>`);
}

export function privacyPage(appUrl: string): string {
  const c = legalContact();
  return legal(appUrl, '/confidentialite', 'Politique de confidentialité', `
<h2>Données de nos clients</h2>
<p>Nous conservons votre email, votre mot de passe (haché, jamais en clair), vos informations de signature et vos prospects. Le paiement est géré par Stripe : nous ne voyons jamais votre carte bancaire.</p>
<p>Ces données servent uniquement à fournir le service. Vous pouvez supprimer votre compte et toutes vos données à tout moment depuis votre espace (rubrique Profil).</p>
<h2>Données des entreprises référencées</h2>
<p>Nous traitons des données professionnelles publiques (nom commercial, adresse, téléphone et email professionnels, site web) sur la base de l’intérêt légitime : aider des prestataires à proposer leurs services aux entreprises. Les pages publiques ne montrent que des statistiques, jamais de coordonnées.</p>
<p>Toute entreprise peut s’opposer au traitement ou demander la suppression de sa fiche : <a href="mailto:${c}">${c}</a>.</p>
<h2>Cookies</h2>
<p>Un seul cookie, strictement nécessaire : celui qui vous garde connecté. Aucun cookie publicitaire ni de mesure d’audience tierce.</p>`);
}

export function termsPage(appUrl: string): string {
  return legal(appUrl, '/cgv', 'Conditions générales', `
<h2>Service</h2>
<p>${BRAND} fournit des listes d’entreprises susceptibles d’avoir besoin d’un site internet, des audits automatiques de sites et des modèles de messages de prospection.</p>
<h2>Offres et paiement</h2>
<p>L’offre Découverte donne accès gratuitement à ${FREE_UNLOCKS} entreprises. Les offres Pro (${PLANS.pro.priceEur} € HT / mois, ${PLANS.pro.unlocks} entreprises par mois) et Agence (${PLANS.agence.priceEur} € HT / mois, ${fmt(PLANS.agence.unlocks)} entreprises par mois) sont des abonnements mensuels sans engagement, payés d’avance par carte via Stripe. Les quotas non utilisés ne sont pas reportés.</p>
<h2>Résiliation</h2>
<p>Vous pouvez résilier à tout moment depuis votre espace. L’abonnement reste actif jusqu’à la fin de la période en cours. Les entreprises déjà débloquées restent accessibles.</p>
<h2>Bon usage</h2>
<p>Vous vous engagez à respecter la réglementation sur la prospection commerciale (RGPD, Code des postes et des communications électroniques), à n’envoyer que des messages en rapport avec l’activité professionnelle du destinataire, à proposer un moyen simple de refuser vos messages et à respecter ces refus. La revente des données est interdite.</p>
<h2>Responsabilité</h2>
<p>Les données proviennent de sources publiques et peuvent contenir des erreurs. ${BRAND} ne garantit pas la signature de contrats.</p>`);
}

export function notFoundPage(appUrl: string): string {
  return layout(appUrl, {
    title: `Page introuvable | ${BRAND}`,
    description: 'Cette page n’existe pas.',
    path: '/404',
    noindex: true,
    body: `<section class="section wrap narrow center"><h1>Page introuvable</h1><p class="lead">Cette page n’existe pas ou a été déplacée.</p><p><a class="btn" href="/">Retour à l’accueil</a></p></section>`,
  });
}

// --- Sitemap / robots ----------------------------------------------------------------

export function sitemapXml(appUrl: string, indexableCityTrades: { city: string; trade: string }[]): string {
  const day = new Date().toISOString().slice(0, 10);
  const paths = [
    '/',
    '/tarifs',
    '/prospection',
    ...CITIES.map((c) => `/prospection/${c.slug}`),
    ...TRADES.map((t) => `/metiers/${t.slug}`),
    ...indexableCityTrades.map((x) => `/prospection/${x.city}/${x.trade}`),
    '/mentions-legales',
    '/cgv',
    '/confidentialite',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${esc(appUrl + p)}</loc><lastmod>${day}</lastmod></url>`).join('\n')}
</urlset>
`;
}

export function robotsTxt(appUrl: string): string {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /app
Disallow: /p/

Sitemap: ${appUrl}/sitemap.xml
`;
}
