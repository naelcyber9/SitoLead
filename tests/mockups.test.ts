import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession } from '../src/auth.ts';
import type { UserRow } from '../src/billing.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import {
  createMockup, defaultData, deleteMockup, mockupQuota, publicMockup, renderMockup, sanitizeData, sectorFor, setRevoked, textOn, updateMockup,
} from '../src/mockups.ts';
import { addOptOuts, getLead, unlockProspect, upsertProspects } from '../src/prospects.ts';
import { createApp } from '../src/server.ts';
import type { RawProspect } from '../src/sources.ts';

const raw = (over: Partial<RawProspect> = {}): RawProspect => ({
  id: 'osm:node/1', source: 'osm', siret: null, name: 'Plomberie du Lac', address: '1 rue du Lac', postal_code: '74000', city: 'Annecy',
  lat: 45.9, lon: 6.1, phone: '04 50 00 00 00', email: null, website: null, created_on: null, ...over,
});

function makeUser(db: ReturnType<typeof openDatabase>, email: string, plan: 'free' | 'pro' = 'free'): UserRow {
  const r = db.prepare('INSERT INTO users (email, pass_hash, created_at, plan, plan_status) VALUES (?, ?, ?, ?, ?)').run(
    email, 'x', nowIso(), plan, plan === 'pro' ? 'active' : null,
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as UserRow;
}

// --- Contenu et rendu ----------------------------------------------------------------------

test('contenu initial réel, sans avis, certification, tarif ni ancienneté inventés', () => {
  const d = defaultData({ name: 'Plomberie du Lac', trade: 'plombier', city: 'ANNECY', phone: '04 50 00 00 00', email: null, address: '1 rue du Lac', postal_code: '74000' });
  assert.equal(d.sector, 'plomberie');
  assert.equal(d.name, 'Plomberie du Lac');
  assert.match(d.tagline, /Annecy/);
  assert.equal(d.phone, '04 50 00 00 00');
  assert.equal(d.hours, ''); // horaires inconnus : rien d'inventé
  const all = JSON.stringify(d).toLowerCase();
  for (const word of ['avis', 'étoile', 'certifi', 'qualibat', 'rge', 'expérience', 'depuis 19', 'depuis 20', '€', 'garanti']) {
    assert.ok(!all.includes(word), `contenu inventé : ${word}`);
  }
  assert.equal(sectorFor('couvreur'), 'couverture');
  assert.equal(sectorFor('climaticien'), 'climatisation');
  assert.equal(sectorFor('avocat'), 'services');
});

test('saisie nettoyée : HTML échappé, couleurs, email et illustration validés, tailles bornées', () => {
  const base = defaultData({ name: 'X', trade: 'plombier', city: 'Annecy', phone: null, email: null, address: null, postal_code: null });
  const d = sanitizeData(
    {
      name: '<script>alert(1)</script>', primary: 'red;}body{display:none', accent: '#AABBCC', email: 'pas-un-email',
      services: ['A', '', 'B', ...Array(20).fill('C')], art: '../../etc', sector: 'inconnu', about: 'x'.repeat(5000),
    },
    base,
  );
  assert.equal(d.primary, base.primary);
  assert.equal(d.accent, '#AABBCC');
  assert.equal(d.email, '');
  assert.equal(d.services.length, 8);
  assert.equal(d.art, base.art);
  assert.equal(d.sector, base.sector);
  assert.equal(d.about.length, 1200);
  const html = renderMockup(d, { name: 'Studio <b>N</b>', email: 'nina@studio.fr', phone: '06 00 00 00 00' });
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Studio &lt;b&gt;N&lt;\/b&gt;/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(html, /non officielle/);
  assert.match(html, /Formulaire de démonstration/);
  assert.equal(textOn('#ffffff'), '#111111');
  assert.equal(textOn('#0f4c81'), '#ffffff');
});

test('quota (1 offerte, la suppression ne la rend pas), expiration, révocation, isolation', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw()], 'plombier', '74010');
  const u = makeUser(db, 'a@b.fr');
  unlockProspect(db, u, 'osm:node/1');
  const lead = getLead(db, u.id, 'osm:node/1')!;
  const r = createMockup(db, u, lead);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.mockup.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(publicMockup(db, r.mockup.id).state, 'ok');
  assert.equal(publicMockup(db, 'nimporte').state, 'missing');
  assert.equal(createMockup(db, u, lead).ok, false); // offre gratuite : 1 maquette
  setRevoked(db, u.id, r.mockup.id, true);
  assert.equal(publicMockup(db, r.mockup.id).state, 'revoked');
  setRevoked(db, u.id, r.mockup.id, false);
  db.prepare('UPDATE mockups SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', r.mockup.id);
  assert.equal(publicMockup(db, r.mockup.id).state, 'expired');
  updateMockup(db, u.id, r.mockup.id, { expiresInDays: 30 });
  assert.equal(publicMockup(db, r.mockup.id).state, 'ok');
  assert.equal(updateMockup(db, 999, r.mockup.id, { data: {} }), null); // autre compte : refusé
  assert.ok(deleteMockup(db, u.id, r.mockup.id));
  assert.equal(mockupQuota(db, u).remaining, 0); // supprimer ne rend pas la maquette offerte
});

test('une opposition de l’entreprise supprime aussi ses maquettes', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, [raw()], 'plombier', '74010');
  const u = makeUser(db, 'a@b.fr');
  unlockProspect(db, u, 'osm:node/1');
  assert.ok(createMockup(db, u, getLead(db, u.id, 'osm:node/1')!).ok);
  addOptOuts(db, ['id:osm:node/1'], 'Demande de suppression');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mockups').get()!.n, 0);
});

// --- API et page publique --------------------------------------------------------------------

const db = openDatabase(':memory:');
let server: Server;
let base = '';
let cookie = '';

before(async () => {
  upsertProspects(db, [raw(), raw({ id: 'osm:node/2', name: 'Autre' })], 'plombier', '74010');
  const handler = createApp({ db, appUrl: 'https://sitolead.test', live: false });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* page HTML */
  }
  return { status: res.status, data, headers: res.headers };
}

test('API : création réservée aux fiches débloquées, page publique non indexée, lien et prix dans le mail, isolation', async () => {
  const nina = makeUser(db, 'nina@studio.fr', 'pro');
  db.prepare('UPDATE users SET full_name = ?, agency_name = ? WHERE id = ?').run('Nina Dupont', 'Studio N', nina.id);
  cookie = `sid=${createSession(db, nina.id)}`;
  assert.equal((await call('POST', '/api/mockups', { prospect_id: 'osm:node/1' })).status, 404); // pas encore débloquée
  await call('POST', '/api/prospects/osm%3Anode%2F1/unlock', {});
  const created = await call('POST', '/api/mockups', { prospect_id: 'osm:node/1' });
  assert.equal(created.status, 201);
  const m = created.data.mockup;
  assert.match(m.url, /^https:\/\/sitolead\.test\/p\/[A-Za-z0-9_-]{22}$/);
  assert.equal(m.active, true);

  const patched = await call('PATCH', `/api/mockups/${m.id}`, { data: { ...m.data, tagline: 'Dépannage <b>rapide</b>', primary: 'javascript:alert(1)' } });
  assert.equal(patched.data.mockup.data.primary, m.data.primary);

  // Page publique : sans compte, non indexée, bandeau « non officielle », aucun script exécutable
  const ninaCookie = cookie;
  cookie = '';
  const pub = await call('GET', `/p/${m.id}`);
  assert.equal(pub.status, 200);
  assert.match(pub.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.match(pub.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.match(pub.data, /Proposition de site réalisée par Studio N/);
  assert.match(pub.data, /non officielle/);
  assert.match(pub.data, /Dépannage &lt;b&gt;rapide&lt;\/b&gt;/);
  assert.doesNotMatch(pub.data, /<script(?! type="application\/ld\+json")/);
  assert.equal((await call('GET', '/p/inexistant000000000000a')).status, 404);
  assert.equal((await call('GET', `/api/mockups/${m.id}`)).status, 401);
  assert.match((await call('GET', '/robots.txt')).data, /Disallow: \/p\//);
  cookie = ninaCookie;
  await call('GET', `/p/${m.id}`); // ouverture par la créatrice : non comptée
  assert.equal(db.prepare('SELECT views FROM mockups WHERE id = ?').get(m.id)!.views, 1);

  const pitch = await call('GET', `/api/leads/${encodeURIComponent('osm:node/1')}/pitch?mockup=${m.id}&price=${encodeURIComponent('990 € HT')}`);
  assert.match(pitch.data.pitch.email, new RegExp(`/p/${m.id}`));
  assert.match(pitch.data.pitch.email, /990 € HT/);
  assert.match(pitch.data.pitch.subject, /proposition de site/);

  // Révocation : lien coupé (410) et retiré du message ; aperçu de l'éditeur toujours disponible
  assert.equal((await call('PUT', `/api/mockups/${m.id}/revoked`, { revoked: true })).data.mockup.active, false);
  cookie = '';
  assert.equal((await call('GET', `/p/${m.id}`)).status, 410);
  cookie = ninaCookie;
  assert.doesNotMatch((await call('GET', `/api/leads/${encodeURIComponent('osm:node/1')}/pitch?mockup=${m.id}`)).data.pitch.email, /\/p\//);
  const preview = await call('GET', `/api/mockups/${m.id}/apercu`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('x-frame-options'), 'SAMEORIGIN');

  // Téléchargement du site : autonome, sans bandeau « proposition », indexable
  const exp = await fetch(`${base}/api/mockups/${m.id}/export`, { headers: { cookie } });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') ?? '', /attachment; filename="plomberie-du-lac\.html"/);
  const site = await exp.text();
  assert.doesNotMatch(site, /non officielle/);
  assert.doesNotMatch(site, /noindex/);
  assert.match(site, /Dépannage &lt;b&gt;rapide&lt;\/b&gt;/);
  assert.match(site, /Formulaire à brancher/);

  // Isolation : un autre compte ne voit, ne modifie ni ne supprime la maquette
  const leo = makeUser(db, 'leo@atelier.fr');
  cookie = `sid=${createSession(db, leo.id)}`;
  assert.equal((await call('GET', `/api/mockups/${m.id}`)).status, 404);
  assert.equal((await call('PATCH', `/api/mockups/${m.id}`, { data: {} })).status, 404);
  assert.equal((await call('DELETE', `/api/mockups/${m.id}`, {})).status, 404);
  assert.equal((await call('GET', `/api/mockups/${m.id}/apercu`)).status, 404);
  assert.equal((await call('GET', `/api/mockups/${m.id}/export`)).status, 404);
  assert.equal((await call('GET', '/api/mockups')).data.items.length, 0);
  cookie = ninaCookie;
  assert.equal((await call('DELETE', `/api/mockups/${m.id}`, {})).status, 200);
});
