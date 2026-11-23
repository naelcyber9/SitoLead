import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { analyzeSite, assertPublicHost, classifyWebsite } from '../src/audit.ts';
import { FREE_UNLOCKS, effectivePlan, handleStripeEvent, quotaFor, verifyStripeSignature, type UserRow } from '../src/billing.ts';
import { openDatabase } from '../src/db.ts';
import { addOptOuts, leadsCsv, listProspects, mask, optOutKey, unlockProspect, upsertProspects, type PublicProspect } from '../src/prospects.ts';
import { buildPitch, opportunityScore } from '../src/scoring.ts';
import { osmToProspect, prettyName, sireneOptOuts, sireneToProspects, type RawProspect } from '../src/sources.ts';

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
  assert.equal(quotaFor(db, row).limit, 150);

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
  assert.equal(q.remaining, 149);
  assert.equal(q.resetsAt, '2026-04-01T00:00:00.000Z');
});
