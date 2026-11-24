// Suivi commercial : statuts, historique, rappels, montants déclarés et statistiques réelles.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSession } from '../src/auth.ts';
import type { UserRow } from '../src/billing.ts';
import { listEvents, migrateStatuses, userStats } from '../src/crm.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import { getLead, leadsCsv, listLeads, unlockProspect, updateLead, upsertProspects } from '../src/prospects.ts';
import { createApp } from '../src/server.ts';
import type { RawProspect } from '../src/sources.ts';

const raw = (id: string): RawProspect => ({
  id, source: 'osm', siret: null, name: `Entreprise ${id}`, address: null, postal_code: '74000', city: 'Annecy',
  lat: null, lon: null, phone: '0450', email: null, website: null, created_on: null,
});

function makeUser(db: ReturnType<typeof openDatabase>, email: string): UserRow {
  const r = db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run(email, 'x', nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as UserRow;
}

test('anciens statuts convertis une seule fois (à contacter → débloqué, rdv / devis → négociation)', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, ['a', 'b', 'c'].map(raw), 'plombier', '74010');
  const u = makeUser(db, 'a@b.fr');
  for (const [id, st] of [['a', 'a_contacter'], ['b', 'rdv'], ['c', 'devis']]) {
    db.prepare('INSERT INTO leads (user_id, prospect_id, unlocked_at, updated_at, status) VALUES (?, ?, ?, ?, ?)').run(u.id, id, nowIso(), nowIso(), st);
  }
  assert.equal(migrateStatuses(db), 3);
  assert.deepEqual(listLeads(db, u.id).map((l) => l.lead!.status).sort(), ['debloque', 'negociation', 'negociation']);
  assert.equal(migrateStatuses(db), 0);
});

test('historique, rappels, « ne plus contacter », montant déclaré et statistiques', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, ['a', 'b', 'c'].map(raw), 'plombier', '74010');
  const u = makeUser(db, 'a@b.fr');
  db.prepare(`UPDATE users SET plan = 'pro', plan_status = 'active' WHERE id = ?`).run(u.id);
  const pro = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as UserRow;
  for (const id of ['a', 'b', 'c']) unlockProspect(db, pro, id);
  assert.equal(getLead(db, u.id, 'a')!.lead!.status, 'debloque');

  updateLead(db, u.id, 'a', { status: 'contacte', next_action_at: '2026-01-01' });
  updateLead(db, u.id, 'b', { status: 'gagne', deal_amount: '1 290,50' });
  updateLead(db, u.id, 'c', { status: 'stop', next_action_at: '2026-01-01' });
  assert.equal(getLead(db, u.id, 'b')!.lead!.deal_amount, 1290.5);
  assert.equal(getLead(db, u.id, 'c')!.lead!.next_action_at, null); // plus de relance
  assert.equal(updateLead(db, u.id, 'b', { deal_amount: '-5' })!.lead!.deal_amount, 1290.5); // montant invalide ignoré
  assert.deepEqual(listEvents(db, u.id, 'a').map((e) => e.kind), ['status', 'unlock']);

  const s = userStats(db, u.id, new Date('2026-06-01'));
  assert.equal(s.unlocked, 3);
  assert.equal(s.contacted, 2); // « contacté » et « gagné » ; « ne plus contacter » n'est pas compté
  assert.equal(s.won, 1);
  assert.equal(s.revenue, 1290.5);
  assert.equal(s.conversionRate, 0.5);
  assert.equal(s.dueToday, 1); // le rappel du prospect « a » est passé
  assert.match(leadsCsv(listLeads(db, u.id)), /Client gagné;.*1290\.5/);
  assert.equal(userStats(db, makeUser(db, 'vide@b.fr').id).conversionRate, null);
});

// --- API ---------------------------------------------------------------------------------

const db = openDatabase(':memory:');
let server: Server;
let base = '';
let cookie = '';
before(async () => {
  upsertProspects(db, [raw('osm:node/1')], 'plombier', '74010');
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
  return { status: res.status, data: (await res.json()) as any };
}

test('API : maquette générée → statut avancé, message préparé enregistré, statistiques et isolation', async () => {
  const u = makeUser(db, 'nina@studio.fr');
  cookie = `sid=${createSession(db, u.id)}`;
  const id = encodeURIComponent('osm:node/1');
  await call('POST', `/api/prospects/${id}/unlock`, {});
  await call('POST', '/api/mockups', { prospect_id: 'osm:node/1' });
  assert.equal((await call('GET', `/api/leads/${id}`)).data.lead.lead.status, 'maquette');
  assert.equal((await call('POST', `/api/leads/${id}/events`, { channel: 'email' })).status, 201);
  const ev = (await call('GET', `/api/leads/${id}/events`)).data.items.map((e: { kind: string }) => e.kind);
  assert.deepEqual(ev, ['message', 'status', 'mockup', 'unlock']);
  const stats = (await call('GET', '/api/stats')).data.stats;
  assert.equal(stats.mockups, 1);
  assert.equal(stats.messagesPrepared, 1);
  assert.equal(stats.contacted, 0); // préparer un message ne vaut pas « contacté » : c'est l'utilisateur qui le déclare
  // Un autre compte n'accède pas à l'historique
  cookie = `sid=${createSession(db, makeUser(db, 'leo@atelier.fr').id)}`;
  assert.equal((await call('GET', `/api/leads/${id}/events`)).status, 404);
  assert.equal((await call('GET', '/api/stats')).data.stats.unlocked, 0);
});
