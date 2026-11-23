import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FREE_UNLOCKS } from '../src/billing.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import { upsertProspects } from '../src/prospects.ts';
import { createApp } from '../src/server.ts';
import type { RawProspect } from '../src/sources.ts';

let server: Server;
let base = '';
const db = openDatabase(':memory:');
const WEBHOOK_SECRET = 'whsec_test_server';

before(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  const raws: RawProspect[] = Array.from({ length: 8 }, (_, i) => ({
    id: `osm:node/${100 + i}`,
    source: 'osm',
    siret: null,
    name: `Plomberie Numéro ${i}`,
    address: `${i} rue du Lac`,
    postal_code: '74000',
    city: 'Annecy',
    lat: 45.9,
    lon: 6.12,
    phone: `04 50 00 00 0${i}`,
    email: i % 2 ? `contact${i}@plomberie.fr` : null,
    website: i === 0 ? 'https://www.facebook.com/plomberie0' : null,
    created_on: null,
  }));
  upsertProspects(db, raws, 'plombier', '74010');
  db.prepare('INSERT INTO searches (key, city_code, city_name, trade, fetched_at, found, errors) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(
    '74010|plombier', '74010', 'Annecy', 'plombier', nowIso(), 8,
  );
  const handler = createApp({
    db,
    appUrl: 'https://sitolead.test',
    live: false,
    checkout: async (u, plan) => `https://checkout.stripe.test/${plan}/${u.id}`,
    portal: async () => 'https://billing.stripe.test/portal',
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

let cookie = '';
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// --- Pages publiques ----------------------------------------------------------------

test('accueil : promesse, appel à l’action, données structurées, en-têtes de sécurité', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.data, /On vous trouve les clients/);
  assert.match(r.data, /application\/ld\+json/);
  assert.match(r.data, /FAQPage/);
  assert.match(r.data, /<link rel="canonical" href="https:\/\/sitolead\.test\/">/);
  assert.match(r.data, new RegExp(`${FREE_UNLOCKS} entreprises offertes`));
  assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('pages ville, métier, ville × métier, tarifs et légales', async () => {
  const city = await call('GET', '/prospection/annecy');
  assert.equal(city.status, 200);
  assert.match(city.data, /agence web à Annecy/);
  assert.match(city.data, />8</); // statistiques réelles
  const ct = await call('GET', '/prospection/annecy/plombier');
  assert.equal(ct.status, 200);
  assert.doesNotMatch(ct.data, /noindex/);
  assert.doesNotMatch(ct.data, /Plomberie Numéro/); // jamais de noms publiés
  const empty = await call('GET', '/prospection/lyon/plombier');
  assert.match(empty.data, /noindex/);
  for (const p of ['/tarifs', '/metiers/coiffeur', '/prospection', '/mentions-legales', '/cgv', '/confidentialite']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  assert.equal((await call('GET', '/prospection/atlantide')).status, 404);
  assert.equal((await call('GET', '/tarifs/')).status, 301);
});

test('sitemap et robots', async () => {
  const s = await call('GET', '/sitemap.xml');
  assert.equal(s.status, 200);
  assert.match(s.data, /<loc>https:\/\/sitolead\.test\/prospection\/annecy\/plombier<\/loc>/);
  assert.doesNotMatch(s.data, /prospection\/lyon\/plombier/);
  const r = await call('GET', '/robots.txt');
  assert.match(r.data, /Sitemap: https:\/\/sitolead\.test\/sitemap\.xml/);
  assert.match(r.data, /Disallow: \/api\//);
});

test('fichiers statiques servis, traversée de répertoire refusée', async () => {
  assert.equal((await call('GET', '/assets/style.css')).status, 200);
  assert.equal((await call('GET', '/app')).status, 200);
  assert.equal((await call('GET', '/assets/..%2F..%2Fpackage.json')).status, 404);
  assert.equal((await call('GET', '/assets/..%5C..%5Cpackage.json')).status, 404);
});

// --- Parcours complet ------------------------------------------------------------------

test('API protégée : connexion requise, CSRF bloqué', async () => {
  assert.equal((await call('GET', '/api/prospects?city=74010&trade=plombier')).status, 401);
  const noJson = await fetch(`${base}/api/signup`, { method: 'POST', body: 'email=a@b.fr', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(noJson.status, 415);
  const evil = await call('POST', '/api/login', { email: 'a@b.fr', password: 'x' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
});

test(`inscription → ${FREE_UNLOCKS} déblocages offerts → blocage → abonnement Stripe → déblocage`, async () => {
  assert.equal((await call('POST', '/api/signup', { email: 'nina@studio.fr', password: 'motdepasse1' })).status, 400); // CGU non acceptées
  assert.equal((await call('POST', '/api/signup', { email: 'nina@studio.fr', password: 'court', terms: true })).status, 400);
  const signup = await call('POST', '/api/signup', { email: 'Nina@Studio.fr', password: 'motdepasse1', terms: true });
  assert.equal(signup.status, 201);
  const setCookie = signup.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  cookie = setCookie.split(';')[0]!;
  assert.equal(signup.data.user.quota.remaining, FREE_UNLOCKS);
  assert.equal((await call('POST', '/api/signup', { email: 'nina@studio.fr', password: 'motdepasse1', terms: true })).status, 409);

  // Recherche : résultats masqués
  const search = await call('GET', '/api/prospects?city=74010&trade=plombier');
  assert.equal(search.status, 200);
  assert.equal(search.data.total, 8);
  const first = search.data.items[0];
  assert.equal(first.unlocked, false);
  assert.equal(first.phone, null);
  assert.match(first.name, /•/);
  assert.equal(search.data.items[0].opportunity >= search.data.items.at(-1).opportunity, true);

  // 5 déblocages offerts
  const ids: string[] = search.data.items.map((p: { id: string }) => p.id);
  for (let i = 0; i < FREE_UNLOCKS; i++) {
    const u = await call('POST', `/api/prospects/${encodeURIComponent(ids[i]!)}/unlock`, {});
    assert.equal(u.status, 200, `déblocage ${i}`);
    assert.equal(u.data.prospect.unlocked, true);
    assert.ok(u.data.prospect.phone);
    assert.equal(u.data.quota.remaining, FREE_UNLOCKS - i - 1);
  }
  const blocked = await call('POST', `/api/prospects/${encodeURIComponent(ids[FREE_UNLOCKS]!)}/unlock`, {});
  assert.equal(blocked.status, 402);
  assert.equal(blocked.data.code, 'upgrade');
  assert.equal((await call('POST', `/api/prospects/${encodeURIComponent(ids[0]!)}/unlock`, {})).status, 200); // déjà débloqué : gratuit

  // Fiche, message, suivi
  await call('PATCH', '/api/me', { full_name: 'Nina Dupont', phone: '06 00 00 00 00', website: 'https://studio-n.fr' });
  assert.equal((await call('PATCH', '/api/me', { website: 'pas une url' })).status, 400);
  const pitch = await call('GET', `/api/leads/${encodeURIComponent(ids[0]!)}/pitch`);
  assert.equal(pitch.status, 200);
  assert.match(pitch.data.pitch.email, /Nina Dupont/);
  assert.equal(pitch.data.profileComplete, true);
  const patched = await call('PATCH', `/api/leads/${encodeURIComponent(ids[0]!)}`, { status: 'rdv', next_action_at: '2026-12-01', note: 'Rappeler' });
  assert.equal(patched.data.lead.lead.status, 'rdv');
  assert.equal((await call('PATCH', `/api/leads/${encodeURIComponent(ids[0]!)}`, { status: 'nimporte' })).data.lead.lead.status, 'rdv');
  assert.equal((await call('GET', `/api/leads/${encodeURIComponent(ids[7]!)}/pitch`)).status, 404); // non débloqué
  const leads = await call('GET', '/api/leads');
  assert.equal(leads.data.items.length, FREE_UNLOCKS);

  // CSV réservé aux offres payantes
  assert.equal((await call('GET', '/api/leads.csv')).status, 402);

  // Abonnement : redirection Checkout puis webhook signé
  const co = await call('POST', '/api/billing/checkout', { plan: 'pro' });
  assert.equal(co.status, 200);
  assert.match(co.data.url, /^https:\/\/checkout\.stripe\.test\/pro\//);
  const me = await call('GET', '/api/me');
  const payload = JSON.stringify({
    id: 'evt_server_1',
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: String(me.data.user.id), customer: 'cus_X', subscription: 'sub_X', metadata: { plan: 'pro' } } },
  });
  const forged = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': 't=1,v1=00' } });
  assert.equal(forged.status, 400);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex');
  const hook = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: payload, headers: { 'stripe-signature': `t=${t},v1=${sig}`, 'content-type': 'application/json' } });
  assert.equal(hook.status, 200);

  const after = await call('GET', '/api/me');
  assert.equal(after.data.user.plan, 'pro');
  assert.equal(after.data.user.quota.limit, 150);
  const unlocked = await call('POST', `/api/prospects/${encodeURIComponent(ids[FREE_UNLOCKS]!)}/unlock`, {});
  assert.equal(unlocked.status, 200);

  const csv = await fetch(`${base}/api/leads.csv`, { headers: { cookie } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /Nom;Métier/);
  assert.match(text, /Plomberie Numéro/);

  // Abonné : le bouton d'offre renvoie au portail de gestion
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'agence' })).data.url, 'https://billing.stripe.test/portal');

  // Suppression refusée tant que l'abonnement est actif
  assert.equal((await call('DELETE', '/api/me', { password: 'motdepasse1' })).status, 409);
});

test('connexion, déconnexion, suppression de compte', async () => {
  cookie = '';
  assert.equal((await call('POST', '/api/login', { email: 'nina@studio.fr', password: 'mauvais-mdp' })).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'inconnu@studio.fr', password: 'motdepasse1' })).status, 401);
  const login = await call('POST', '/api/login', { email: 'nina@studio.fr', password: 'motdepasse1' });
  assert.equal(login.status, 200);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.equal((await call('GET', '/api/me')).data.user.email, 'nina@studio.fr');
  await call('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/me')).data.user, null);

  const s = await call('POST', '/api/signup', { email: 'temp@studio.fr', password: 'motdepasse2', terms: true });
  cookie = (s.headers.get('set-cookie') ?? '').split(';')[0]!;
  assert.equal((await call('DELETE', '/api/me', { password: 'faux' })).status, 403);
  assert.equal((await call('DELETE', '/api/me', { password: 'motdepasse2' })).status, 200);
  assert.equal((await call('GET', '/api/me')).data.user, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('temp@studio.fr')!.n, 0);
});
