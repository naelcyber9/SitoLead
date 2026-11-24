// Offres, packs de crédits et paiements échoués (aucun appel réel à Stripe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, creditBalance, effectivePlan, graceEndsAt, handleStripeEvent, quotaFor, type UserRow } from '../src/billing.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import { unlockProspect, upsertProspects } from '../src/prospects.ts';
import type { RawProspect } from '../src/sources.ts';

const raw = (id: string): RawProspect => ({
  id, source: 'osm', siret: null, name: id, address: null, postal_code: null, city: 'Annecy', lat: null, lon: null, phone: null, email: null, website: null, created_on: null,
});
const user = (db: ReturnType<typeof openDatabase>, id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow;

test('grille : 4 offres, annuel = 10 mois, aucune offre illimitée', () => {
  assert.deepEqual(Object.keys(PLANS), ['free', 'starter', 'pro', 'agence']);
  for (const p of Object.values(PLANS)) {
    assert.equal(p.yearlyEur, p.priceEur * 10);
    for (const v of [p.unlocks, p.mockups, p.aiPerMonth, p.mediaMax, p.searchesPerDay]) assert.ok(Number.isFinite(v) && v > 0);
  }
  assert.deepEqual([PLANS.starter.priceEur, PLANS.pro.priceEur, PLANS.agence.priceEur], [19, 49, 99]);
});

test('pack de crédits : ajouté une fois, seulement payé, utilisé après le quota de l’offre', () => {
  const db = openDatabase(':memory:');
  upsertProspects(db, Array.from({ length: 8 }, (_, i) => raw(`p${i}`)), 'plombier', '74010');
  const id = Number(db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run('a@b.fr', 'x', nowIso()).lastInsertRowid);
  const session = (evt: string, status: string) => ({
    id: evt,
    type: 'checkout.session.completed',
    data: { object: { id: `cs_${evt}`, client_reference_id: String(id), payment_status: status, metadata: { pack: 'leads50' } } },
  });
  assert.equal(handleStripeEvent(db, session('e0', 'unpaid')), 'ignored');
  assert.equal(handleStripeEvent(db, session('e1', 'paid')), 'ok');
  assert.equal(handleStripeEvent(db, session('e1', 'paid')), 'duplicate');
  assert.equal(creditBalance(db, id), 50);
  // Offre gratuite : 5 déblocages offerts, puis les crédits prennent le relais
  for (let i = 0; i < 7; i++) assert.ok(unlockProspect(db, user(db, id), `p${i}`).ok);
  assert.equal(creditBalance(db, id), 48);
  const q = quotaFor(db, user(db, id));
  assert.equal(q.used, 5);
  assert.equal(q.credits, 48);
  assert.equal(q.remaining, 48);
});

test('paiement échoué : accès maintenu 7 jours, puis suspendu, rétabli au paiement', () => {
  const db = openDatabase(':memory:');
  const id = Number(
    db.prepare(`INSERT INTO users (email, pass_hash, created_at, plan, plan_status, stripe_customer_id) VALUES (?, ?, ?, 'pro', 'active', 'cus_1')`).run('a@b.fr', 'x', nowIso())
      .lastInsertRowid,
  );
  handleStripeEvent(db, { id: 'f1', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
  const u = user(db, id);
  assert.equal(u.plan_status, 'past_due');
  const end = Date.parse(graceEndsAt(u)!);
  assert.equal(effectivePlan(u, new Date(end - 86_400_000)).id, 'pro'); // pendant le délai
  assert.equal(effectivePlan(u, new Date(end + 86_400_000)).id, 'free'); // après le délai
  // Un second échec ne repousse pas le délai
  handleStripeEvent(db, { id: 'f2', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
  assert.equal(user(db, id).payment_failed_at, u.payment_failed_at);
  handleStripeEvent(db, { id: 'p1', type: 'invoice.paid', data: { object: { customer: 'cus_1' } } });
  const paid = user(db, id);
  assert.equal(paid.plan_status, 'active');
  assert.equal(paid.payment_failed_at, null);
  assert.equal(effectivePlan(paid).id, 'pro');
});

test('abonnement annuel : rythme enregistré à l’activation', () => {
  const db = openDatabase(':memory:');
  const id = Number(db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run('a@b.fr', 'x', nowIso()).lastInsertRowid);
  handleStripeEvent(db, {
    id: 'c1',
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: String(id), customer: 'cus_2', subscription: 'sub_2', metadata: { plan: 'starter', interval: 'year' } } },
  });
  const u = user(db, id);
  assert.equal(u.plan, 'starter');
  assert.equal(u.billing_interval, 'year');
  assert.equal(quotaFor(db, u).limit, PLANS.starter.unlocks);
});
