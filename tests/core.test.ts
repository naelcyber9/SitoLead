import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { analyzeSite, assertPublicHost, classifyWebsite } from '../src/audit.ts';
import { FREE_UNLOCKS, PLANS, effectivePlan, handleStripeEvent, quotaFor, verifyStripeSignature, type UserRow } from '../src/billing.ts';
import { openDatabase } from '../src/db.ts';
import {
  addOptOuts, leadsCsv, listProspects, mask, optOutKey, osmStatus, refreshCityOsm, rescoreIfNeeded, setSiteCheck, shouldRetry, unlockProspect,
  upsertProspects, type PublicProspect,
} from '../src/prospects.ts';
import { TRADES } from '../src/catalog.ts';
import { buildPitch, opportunityDetails, opportunityScore } from '../src/scoring.ts';
import { distanceKm, parseZone } from '../src/zones.ts';
import { osmToProspect, osmTrade, prettyName, sireneCommuneCodes, sireneOptOuts, sireneToProspects, type RawProspect } from '../src/sources.ts';

const raw = (over: Partial<RawProspect> = {}): RawProspect => ({
  id: 'osm:node/1',
  source: 'osm',
  siret: null,
  name: 'Plomberie Test',
  address: '1 rue du Lac',
  postal_code: '74000',
  city: 'Annecy',
  lat: 45.9,
  lon: 6.1,
  phone: '04 50 00 00 00',
  email: null,
  website: null,
  created_on: null,
  ...over,
});

function makeUser(db: ReturnType<typeof openDatabase>, email = 'a@b.fr'): UserRow {
  const r = db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run(email, 'x', new Date().toISOString());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as UserRow;
}

// --- Audit ---------------------------------------------------------------------------

test('classifyWebsite distingue absence, réseau social et vrai site', () => {
  assert.equal(classifyWebsite(null), 'none');
  assert.equal(classifyWebsite('  '), 'none');
  assert.equal(classifyWebsite('https://www.facebook.com/plomberie'), 'social');
  assert.equal(classifyWebsite('instagram.com/salon'), 'social');
  assert.equal(classifyWebsite('plomberie-annecy.fr'), 'site');
});

test('analyzeSite : site daté, non sécurisé, non mobile = site à refaire', () => {
  const html = '<html><head><title>Accueil</title></head><body><p>© 2014 Plomberie</p></body></html>';
  const r = analyzeSite({ requestedUrl: 'http://x.fr', finalUrl: 'http://x.fr/', status: 200, html, ms: 4200 }, new Date('2026-06-01'));
  assert.equal(r.status, 'weak');
  const codes = r.issues.map((i) => i.code);
  for (const c of ['no_https', 'no_mobile', 'no_title', 'slow', 'outdated', 'no_contact', 'thin']) assert.ok(codes.includes(c), c);
  assert.ok(r.score! < 40);
});

test('analyzeSite : site moderne = correct', () => {
  const html = `<html><head><title>Plomberie Martin, dépannage à Annecy</title>
    <meta name="viewport" content="width=device-width">
    <meta name="description" content="Plombier à Annecy, dépannage 7j/7, devis gratuit en 24 h.">
    <script type="application/ld+json">{}</script></head>
    <body><h1>Plomberie</h1><a href="tel:0450">Appeler</a><form></form>${'x'.repeat(2000)}<p>© 2026</p></body></html>`;
  const r = analyzeSite({ requestedUrl: 'https://x.fr', finalUrl: 'https://x.fr/', status: 200, html, ms: 600 }, new Date('2026-06-01'));
  assert.equal(r.status, 'ok');
  assert.equal(r.score, 100);
});

test('analyzeSite : erreur HTTP ou absence de réponse = hors service', () => {
  assert.equal(analyzeSite({ requestedUrl: 'x', finalUrl: 'http://x.fr', status: 0, html: '', ms: 9000 }).status, 'down');
  assert.equal(analyzeSite({ requestedUrl: 'x', finalUrl: 'http://x.fr', status: 503, html: '', ms: 10 }).status, 'down');
});

test('assertPublicHost refuse le réseau interne (SSRF)', async () => {
  for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '[::1]', 'printer.local']) {
    await assert.rejects(assertPublicHost(h), h);
  }
});

// --- Scoring et messages ---------------------------------------------------------------

test('opportunityScore : sans site > site faible > site correct, bonus contacts et création récente', () => {
  const base = { phone: null, email: null, created_on: null, audit_score: null };
  const none = opportunityScore({ ...base, site_status: 'none' });
  const weak = opportunityScore({ ...base, site_status: 'weak', audit_score: 40 });
  const ok = opportunityScore({ ...base, site_status: 'ok', audit_score: 90 });
  assert.ok(none > weak && weak > ok, `${none} > ${weak} > ${ok}`);
  const now = new Date('2026-06-01');
  assert.ok(opportunityScore({ ...base, site_status: 'none', phone: '1', created_on: '2026-01-10' }, now) > none);
  assert.ok(opportunityScore({ ...base, site_status: 'none', phone: '1', email: 'a', created_on: '2026-01-10' }, now) <= 100);
});

test('buildPitch personnalise et inclut la désinscription', () => {
  const p = buildPitch(
    { name: 'Salon Léa', trade: 'coiffeur', city: 'ANNECY', phone: null, email: null, website: null, created_on: null, site_status: 'none', audit_score: null, audit_issues: [] },
    { full_name: 'Nina Dupont', agency_name: 'Studio N', phone: '06 00 00 00 00', website: 'https://studio-n.fr', email: 'n@studio-n.fr' },
  );
  assert.match(p.subject, /Salon Léa/);
  assert.match(p.email, /coiffeur à Annecy/);
  assert.match(p.email, /STOP/);
  assert.match(p.email, /Nina Dupont/);
  assert.match(p.sms, /STOP/);
  assert.match(p.call, /Nina Dupont/);
});

// --- Sources ---------------------------------------------------------------------------

test('osmToProspect ignore les enseignes nationales et lit les contacts', () => {
  assert.equal(osmToProspect({ type: 'node', id: 1, tags: { name: 'Franchise', 'brand:wikidata': 'Q1' } }, 'Annecy'), null);
  assert.equal(osmToProspect({ type: 'node', id: 1, tags: {} }, 'Annecy'), null);
  const p = osmToProspect({ type: 'way', id: 7, center: { lat: 1, lon: 2 }, tags: { name: 'Fleurs', 'contact:phone': '0102', 'contact:facebook': 'https://facebook.com/f' } }, 'Annecy')!;
  assert.equal(p.id, 'osm:way/7');
  assert.equal(p.phone, '0102');
  assert.equal(p.website, 'https://facebook.com/f');
  assert.equal(p.lat, 1);
});

test('sireneToProspects garde les établissements actifs, récents, du bon métier et de la bonne commune', () => {
  const etab = (o: object) => ({
    siret: '12345678900011', commune: '74010', etat_administratif: 'A', activite_principale: '43.22A', adresse: '3 RUE X 74000 ANNECY',
    code_postal: '74000', libelle_commune: 'ANNECY', date_creation: '2026-03-01', latitude: '45.9', longitude: '6.1', nom_commercial: null, liste_enseignes: null, ...o,
  });
  const out = sireneToProspects(
    [{ nom_complet: 'SARL EAU', matching_etablissements: [etab({}), etab({ siret: '2', etat_administratif: 'F' }), etab({ siret: '3', date_creation: '2010-01-01' }), etab({ siret: '4', commune: '75056' })] }],
    { code: '74010', nom: 'Annecy', departement: '74', population: 0, codesPostaux: [] },
    '43.22A',
    24,
    new Date('2026-06-01'),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.address, '3 Rue X');
  assert.equal(out[0]!.name, 'SARL Eau');
  assert.equal(out[0]!.city, 'Annecy');
});

test('SIRENE : les entreprises opposées à la prospection ou non diffusibles ne sont jamais proposées', () => {
  const commune = { code: '74010', nom: 'Annecy', departement: '74', population: 0, codesPostaux: [] };
  const etab = (o: object = {}) => ({
    siret: '11111111100011', commune: '74010', etat_administratif: 'A', activite_principale: '43.22A', adresse: '3 RUE X 74000 ANNECY',
    code_postal: '74000', libelle_commune: 'ANNECY', date_creation: '2026-03-01', latitude: null, longitude: null, nom_commercial: null,
    liste_enseignes: null, statut_diffusion_etablissement: 'O', ...o,
  });
  const results = [
    { siren: '111111111', nom_complet: 'OUVERTE', statut_diffusion: 'O', opposition_diffusion_commerciale: false, matching_etablissements: [etab()] },
    { siren: '222222222', nom_complet: 'OPPOSEE', statut_diffusion: 'O', opposition_diffusion_commerciale: true, matching_etablissements: [etab({ siret: '22222222200011' })] },
    { siren: '333333333', nom_complet: 'PARTIELLE', statut_diffusion: 'P', opposition_diffusion_commerciale: false, matching_etablissements: [etab({ siret: '33333333300011' })] },
    { siren: '444444444', nom_complet: 'ETAB PROTEGE', statut_diffusion: 'O', matching_etablissements: [etab({ siret: '44444444400011', statut_diffusion_etablissement: 'P' })] },
    { siren: '555555555', nom_complet: 'ADRESSE MASQUEE', statut_diffusion: 'O', matching_etablissements: [etab({ siret: '55555555500011', code_postal: '[NON-DIFFUSIBLE]' })] },
  ];
  const out = sireneToProspects(results, commune, '43.22A', 24, new Date('2026-06-01'));
  assert.deepEqual(out.map((p) => p.name), ['Ouverte']);
  assert.deepEqual(sireneOptOuts(results).sort(), ['222222222', '333333333']);
});

test('prettyName : casse lisible, formes juridiques et petits mots conservés', () => {
  assert.equal(prettyName('PLOMBERIE DU LAC SARL'), 'Plomberie du Lac SARL');
  assert.equal(prettyName("L'ATELIER DE JEAN-PIERRE"), "L'Atelier de Jean-Pierre");
  assert.equal(prettyName('Déjà Bien Écrit'), 'Déjà Bien Écrit');
  assert.equal(prettyName('ÉLECTRICITÉ GÉNÉRALE (EURL)'), 'Électricité Générale (EURL)');
});

test('oppositions : clés reconnues, fiches supprimées et plus jamais réimportées', () => {
  assert.equal(optOutKey('123 456 789 00011'), 'siret:12345678900011');
  assert.equal(optOutKey('123456789'), 'siren:123456789');
  assert.equal(optOutKey('Contact@Exemple.FR'), 'email:contact@exemple.fr');
  assert.equal(optOutKey('+33 4 50 00 00 01'), 'phone:0450000001');
  assert.equal(optOutKey('04.50.00.00.01'), 'phone:0450000001');
  assert.equal(optOutKey('osm:node/42'), 'id:osm:node/42');
  assert.equal(optOutKey('n’importe quoi'), null);

  const db = openDatabase(':memory:');
  upsertProspects(db, [
    raw({ id: 'osm:node/1', siret: '99999999900011' }),
    raw({ id: 'osm:node/2', phone: '+33 4 50 00 00 02' }),
    raw({ id: 'osm:node/3', phone: null, email: 'Pro@Exemple.fr' }),
    raw({ id: 'osm:node/4', phone: null }),
  ], 'plombier', '74010');
  const u = makeUser(db);
  unlockProspect(db, u, 'osm:node/1');
  assert.equal(addOptOuts(db, ['siren:999999999'], 'Opposition SIRENE'), 1);
  assert.equal(addOptOuts(db, ['phone:0450000002'], 'Demande'), 1);
  assert.equal(addOptOuts(db, ['email:pro@exemple.fr'], 'Demande'), 1);
  const left = (db.prepare('SELECT id FROM prospects').all() as { id: string }[]).map((r) => r.id);
  assert.deepEqual(left, ['osm:node/4']);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM leads').get() as { n: number }).n), 0);
  // Réimport depuis les sources : toujours écartées
  const n = upsertProspects(db, [
    raw({ id: 'osm:node/1', siret: '99999999900011' }),
    raw({ id: 'osm:node/9', siret: '99999999900029' }),
    raw({ id: 'osm:node/2', phone: '04 50 00 00 02' }),
    raw({ id: 'osm:node/3', phone: null, email: 'pro@exemple.fr' }),
  ], 'plombier', '74010');
  assert.equal(n, 0);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM prospects').get() as { n: number }).n), 1);
});

// --- Prospects -------------------------------------------------------------------------

test('upsertProspects déduplique par SIRET sans écraser le site trouvé sur OSM', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ id: 'osm:node/1', siret: '111', website: 'https://plomberie.fr' })], 'plombier', '74010');
  upsertProspects(db, [raw({ id: 'sirene:111', source: 'sirene', siret: '111', website: null, phone: null, created_on: '2026-01-01' })], 'plombier', '74010');
  const rows = db.prepare('SELECT * FROM prospects').all() as { website: string; created_on: string; phone: string; site_status: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.website, 'https://plomberie.fr');
  assert.equal(rows[0]!.created_on, '2026-01-01');
  assert.equal(rows[0]!.phone, '04 50 00 00 00');
  assert.equal(rows[0]!.site_status, 'pending');
});

test(`quota : ${FREE_UNLOCKS} entreprises offertes puis blocage, re-déblocage gratuit`, () => {
  const db = openDatabase(':memory:');
  const raws = Array.from({ length: FREE_UNLOCKS + 2 }, (_, i) => raw({ id: `osm:node/${i}`, name: `Entreprise ${i}` }));
  upsertProspects(db, raws, 'plombier', '74010');
  const u = makeUser(db);
  for (let i = 0; i < FREE_UNLOCKS; i++) assert.equal(unlockProspect(db, u, `osm:node/${i}`).ok, true);
  const blocked = unlockProspect(db, u, `osm:node/${FREE_UNLOCKS}`);
  assert.deepEqual(blocked, { ok: false, reason: 'quota' });
  const again = unlockProspect(db, u, 'osm:node/0');
  assert.equal(again.ok && again.already, true);
  assert.equal(quotaFor(db, u).remaining, 0);
  assert.deepEqual(unlockProspect(db, u, 'nope'), { ok: false, reason: 'not_found' });
});

test('listProspects masque les coordonnées tant que la fiche n’est pas débloquée', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ email: 'pro@plomberie.fr' })], 'plombier', '74010');
  const u = makeUser(db);
  const locked = listProspects(db, u.id, { cityCode: '74010', trade: 'plombier' }).items[0]!;
  assert.equal(locked.unlocked, false);
  assert.equal(locked.phone, null);
  assert.equal(locked.email, null);
  assert.equal(locked.address, null);
  assert.equal(locked.hasPhone, true);
  assert.notEqual(locked.name, 'Plomberie Test');
  unlockProspect(db, u, 'osm:node/1');
  const open = listProspects(db, u.id, { cityCode: '74010', trade: 'plombier' }).items[0]!;
  assert.equal(open.name, 'Plomberie Test');
  assert.equal(open.email, 'pro@plomberie.fr');
});

test('mask garde la première lettre de chaque mot', () => {
  assert.equal(mask('Boulangerie du Lac'), 'B•••••••• d• L••');
});

test('leadsCsv neutralise les formules (injection CSV)', () => {
  const lead = { name: '=HYPERLINK("http://x")', tradeLabel: 'Plombier', lead: { status: 'a_contacter', note: 'a;b' } } as unknown as PublicProspect;
  const csv = leadsCsv([lead]);
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(csv.includes('"a;b"'));
});

// --- Facturation -----------------------------------------------------------------------

test('verifyStripeSignature accepte une signature valide et refuse le reste', () => {
  const secret = 'whsec_test';
  const payload = '{"id":"evt_1"}';
  const t = 1_700_000_000;
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, t), true);
  assert.equal(verifyStripeSignature(payload + ' ', `t=${t},v1=${sig}`, secret, t), false);
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'autre', t), false);
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, t + 3600), false);
  assert.equal(verifyStripeSignature(payload, undefined, secret, t), false);
});

test('webhooks Stripe : activation, idempotence, résiliation', () => {
  const db = openDatabase(':memory:');
  const u = makeUser(db);
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: String(u.id), customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'pro' } } } };
  assert.equal(handleStripeEvent(db, ev), 'ok');
  assert.equal(handleStripeEvent(db, ev), 'duplicate');
  let row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as UserRow;
  assert.equal(effectivePlan(row).id, 'pro');
  assert.equal(quotaFor(db, row).limit, PLANS.pro.unlocks);

  handleStripeEvent(db, { id: 'evt_2', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
  row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as UserRow;
  assert.equal(row.plan_status, 'past_due');
  assert.equal(effectivePlan(row).id, 'pro'); // délai de grâce pendant les relances de paiement

  handleStripeEvent(db, { id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: {} } } });
  row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as UserRow;
  assert.equal(effectivePlan(row).id, 'free');
});

test('quota mensuel : les déblocages des mois précédents ne comptent pas', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ id: 'osm:node/1' }), raw({ id: 'osm:node/2' })], 'plombier', '74010');
  const u = makeUser(db);
  db.prepare(`UPDATE users SET plan = 'pro', plan_status = 'active' WHERE id = ?`).run(u.id);
  db.prepare(`INSERT INTO leads (user_id, prospect_id, unlocked_at, updated_at) VALUES (?, 'osm:node/1', '2026-01-15T00:00:00.000Z', '2026-01-15T00:00:00.000Z')`).run(u.id);
  db.prepare(`INSERT INTO leads (user_id, prospect_id, unlocked_at, updated_at) VALUES (?, 'osm:node/2', '2026-03-02T00:00:00.000Z', '2026-03-02T00:00:00.000Z')`).run(u.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as UserRow;
  const q = quotaFor(db, row, new Date('2026-03-20T12:00:00Z'));
  assert.equal(q.used, 1);
  assert.equal(q.remaining, PLANS.pro.unlocks - 1);
  assert.equal(q.resetsAt, '2026-04-01T00:00:00.000Z');
});

// --- Collecte par commune et préchargement ------------------------------------------------

test('osmTrade classe un élément OpenStreetMap dans le bon métier', () => {
  assert.equal(osmTrade({ craft: 'plumber', name: 'X' }, TRADES)?.slug, 'plombier');
  assert.equal(osmTrade({ shop: 'bakery', name: 'X' }, TRADES)?.slug, 'boulangerie');
  assert.equal(osmTrade({ shop: 'supermarket', name: 'X' }, TRADES), undefined);
  assert.equal(osmTrade(undefined, TRADES), undefined);
});

test('SIRENE : Paris, Lyon et Marseille sont cherchées par arrondissement', () => {
  assert.equal(sireneCommuneCodes('75056').length, 20);
  assert.equal(sireneCommuneCodes('75056')[0], '75101');
  assert.deepEqual(sireneCommuneCodes('69123').slice(0, 2), ['69381', '69382']);
  assert.equal(sireneCommuneCodes('13055').at(-1), '13216');
  assert.deepEqual(sireneCommuneCodes('74010'), ['74010']);
  const lyon = { code: '69123', nom: 'Lyon', departement: '69', population: 0, codesPostaux: [] };
  const etab = {
    siret: '12345678900011', commune: '69383', etat_administratif: 'A', activite_principale: '96.02A', adresse: '3 RUE X 69003 LYON',
    code_postal: '69003', libelle_commune: 'LYON 3EME', date_creation: '2026-03-01', latitude: null, longitude: null, nom_commercial: null, liste_enseignes: null,
  };
  assert.equal(sireneToProspects([{ nom_complet: 'SALON', statut_diffusion: 'O', matching_etablissements: [etab] }], lyon, '96.02A', 24, new Date('2026-06-01')).length, 1);
});

test('refreshCityOsm charge tous les métiers d’une commune en une fois, et espace les tentatives après un échec', async () => {
  const db = openDatabase(':memory:');
  const commune = { code: '74010', nom: 'Annecy', departement: '74', population: 0, codesPostaux: [] };
  let calls = 0;
  await refreshCityOsm(db, commune, async () => {
    calls++;
    return new Map([
      ['plombier', [raw({ id: 'osm:node/1' })]],
      ['coiffeur', [raw({ id: 'osm:node/2', name: 'Salon' })]],
    ]);
  });
  assert.equal(calls, 1);
  const trades = (db.prepare('SELECT trade FROM prospects ORDER BY trade').all() as { trade: string }[]).map((r) => r.trade);
  assert.deepEqual(trades, ['coiffeur', 'plombier']);
  assert.equal(osmStatus(db, '74010').fresh, true);

  const fail = async (): Promise<Map<string, RawProspect[]>> => {
    throw new Error('OpenStreetMap ne répond pas');
  };
  await assert.rejects(refreshCityOsm(db, { ...commune, code: '35238', nom: 'Rennes' }, fail));
  const st = osmStatus(db, '35238');
  assert.equal(st.fresh, false);
  assert.equal(st.retryLater, true);
  assert.match(st.error ?? '', /ne répond pas/);
});

test('shouldRetry : seule une recherche incomplète et assez ancienne est retentée', () => {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const recent = new Date().toISOString();
  assert.equal(shouldRetry({ fetched_at: old, found: 3, errors: ['OSM'], fresh: true }), true);
  assert.equal(shouldRetry({ fetched_at: recent, found: 3, errors: ['OSM'], fresh: true }), false);
  assert.equal(shouldRetry({ fetched_at: old, found: 3, errors: [], fresh: true }), false);
});

// --- Phase 1 : zones, score expliqué, vérification du site, filtres -----------------------

test('parseZone accepte commune, département, région et rayon, refuse le reste', () => {
  assert.deepEqual(parseZone('commune:74010'), { kind: 'commune', code: '74010' });
  assert.deepEqual(parseZone('departement:2a'), { kind: 'departement', code: '2A' });
  assert.deepEqual(parseZone('departement:971'), { kind: 'departement', code: '971' });
  assert.deepEqual(parseZone('region:84'), { kind: 'region', code: '84' });
  assert.deepEqual(parseZone('rayon:74010:20'), { kind: 'rayon', code: '74010', km: 20 });
  assert.equal(parseZone('rayon:74010:7'), null); // rayon hors liste
  assert.equal(parseZone('departement:99'), null);
  assert.equal(parseZone("commune:74010' OR 1=1"), null);
  assert.equal(parseZone(''), null);
  assert.ok(Math.abs(distanceKm({ lat: 45.899, lon: 6.129 }, { lat: 45.564, lon: 5.917 }) - 41) < 2); // Annecy → Chambéry
});

test('score expliqué : la somme des critères donne le score, l’absence vérifiée pèse plus que l’absence non renseignée', () => {
  const base = { audit_score: null, phone: '0450', email: null, created_on: null };
  const unverified = opportunityDetails({ ...base, site_status: 'none' });
  const verified = opportunityDetails({ ...base, site_status: 'verified_none' });
  assert.ok(verified.score > unverified.score);
  assert.equal(unverified.factors.reduce((n, f) => n + f.points, 0), unverified.score);
  assert.match(unverified.factors[0]!.label, /à vérifier/);
  const stale = opportunityDetails({ ...base, site_status: 'none', updated_at: '2020-01-01T00:00:00Z' }, new Date('2026-06-01'));
  assert.ok(stale.factors.some((f) => f.points < 0 && /plus d’un an/.test(f.label)));
});

test('listProspects : filtre par département (préfixe), coordonnées et source', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ id: 'osm:node/1', phone: '0450', email: null })], 'plombier', '74010');
  upsertProspects(db, [raw({ id: 'osm:node/2', phone: null, email: 'a@b.fr' })], 'plombier', '74081');
  upsertProspects(db, [raw({ id: 'sirene:1', source: 'sirene', phone: null, email: null })], 'plombier', '73065');
  assert.equal(listProspects(db, null, { cityPrefixes: ['74'], trade: 'plombier' }).total, 2);
  assert.equal(listProspects(db, null, { cityPrefixes: ['74', '73'], trade: 'plombier' }).total, 3);
  assert.equal(listProspects(db, null, { cityPrefixes: ['74'], contact: 'email' }).total, 1);
  assert.equal(listProspects(db, null, { cityPrefixes: ['74', '73'], contact: 'any' }).total, 2);
  assert.equal(listProspects(db, null, { cityPrefixes: ['74', '73'], source: 'sirene' }).total, 1);
  assert.equal(listProspects(db, null, { cityPrefixes: ["74%' OR 1=1 --"] }).total, 0); // préfixe invalide ignoré
  const locked = listProspects(db, null, { cityCode: '74010' }).items[0]!;
  assert.equal(locked.lat, 45.9); // arrondi à 2 décimales (~1 km)
  assert.equal(locked.approxPosition, true);
});

test('setSiteCheck : site trouvé audité, absence vérifiée, retour à la source', async () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ id: 'osm:node/1' })], 'plombier', '74010');
  const u = makeUser(db);
  unlockProspect(db, u, 'osm:node/1');
  const fakeAudit = async () => ({ status: 'weak' as const, score: 40, issues: [{ code: 'no_https', label: 'Pas de HTTPS', weight: 20 }] });
  const found = await setSiteCheck(db, u.id, 'osm:node/1', { kind: 'site_found', url: 'plomberie-test.fr' }, fakeAudit);
  assert.equal(found!.site_status, 'weak');
  assert.equal(found!.audit_score, 40);
  assert.equal(found!.website, 'plomberie-test.fr');
  const none = await setSiteCheck(db, u.id, 'osm:node/1', { kind: 'verified_none' }, fakeAudit);
  assert.equal(none!.site_status, 'verified_none');
  const reset = await setSiteCheck(db, u.id, 'osm:node/1', { kind: null }, fakeAudit);
  assert.equal(reset!.site_status, 'none');
  await assert.rejects(setSiteCheck(db, u.id, 'osm:node/1', { kind: 'site_found', url: '' }, fakeAudit));
  assert.equal(await setSiteCheck(db, 999, 'osm:node/1', { kind: 'verified_none' }, fakeAudit), null); // pas débloqué par ce compte
});

test('rescoreIfNeeded recalcule une seule fois par version du barème', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw({ id: 'osm:node/1' })], 'plombier', '74010');
  db.prepare('UPDATE prospects SET opportunity = 1').run();
  assert.equal(rescoreIfNeeded(db), 1);
  assert.notEqual(db.prepare('SELECT opportunity FROM prospects').get()!.opportunity, 1);
  assert.equal(rescoreIfNeeded(db), 0);
});
