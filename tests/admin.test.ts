// Administration, changement de mot de passe, export RGPD et sauvegardes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, ensureAdmin, exportUserData } from '../src/admin.ts';
import { createSession, hashPassword } from '../src/auth.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import { upsertProspects } from '../src/prospects.ts';
import { createApp } from '../src/server.ts';

const db = openDatabase(':memory:');
let server: Server;
let base = '';
before(async () => {
  upsertProspects(
    db,
    [{ id: 'osm:node/1', source: 'osm', siret: '12345678900011', name: 'Plomberie du Lac', address: null, postal_code: '74000', city: 'Annecy', lat: null, lon: null, phone: '0450', email: null, website: null, created_on: null }],
    'plombier',
    '74010',
  );
  const handler = createApp({ db, appUrl: 'https://sitolead.test', live: false });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any, headers: res.headers };
}

test('compte admin : créé avec un mot de passe provisoire, ou rôle donné à un compte existant', async () => {
  const r = await ensureAdmin(db, 'Admin@SitoLead.fr');
  assert.equal(r.created, true);
  assert.ok(r.password && r.password.length >= 12);
  const again = await ensureAdmin(db, 'admin@sitolead.fr');
  assert.deepEqual(again, { created: false, password: null });
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@sitolead.fr', password: r.password }),
  });
  assert.equal(login.status, 200);
  assert.equal(((await login.json()) as any).user.admin, true);
});

test('espace admin : réservé au rôle admin, indicateurs, crédits offerts, suppression RGPD', async () => {
  const user = Number(db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run('nina@studio.fr', 'x', nowIso()).lastInsertRowid);
  const nina = `sid=${createSession(db, user)}`;
  for (const [m, p] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/users'], ['POST', '/api/admin/backup'], ['POST', '/api/admin/optouts']] as const) {
    assert.equal((await call(nina, m, p, m === 'POST' ? {} : undefined)).status, 404, p);
  }
  assert.equal((await call(nina, 'POST', `/api/admin/users/${user}/credits`, { amount: 50 })).status, 404);

  const adminId = (db.prepare('SELECT id FROM users WHERE email = ?').get('admin@sitolead.fr') as { id: number }).id;
  const admin = `sid=${createSession(db, adminId)}`;
  const o = await call(admin, 'GET', '/api/admin/overview');
  assert.equal(o.status, 200);
  assert.equal(o.data.overview.users, 2);
  assert.ok(Array.isArray(o.data.alerts));
  assert.equal((await call(admin, 'GET', '/api/admin/users?q=nina')).data.items.length, 1);
  assert.equal((await call(admin, 'POST', `/api/admin/users/${user}/credits`, { amount: 0 })).status, 400);
  assert.equal((await call(admin, 'POST', `/api/admin/users/${user}/credits`, { amount: 25 })).status, 200);
  assert.equal((await call(nina, 'GET', '/api/me')).data.user.quota.credits, 25);
  const opt = await call(admin, 'POST', '/api/admin/optouts', { value: '123 456 789 00011' });
  assert.equal(opt.data.key, 'siret:12345678900011');
  assert.equal(opt.data.removed, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prospects').get()!.n, 0);
});

test('changement de mot de passe : ancien vérifié, autres sessions fermées', async () => {
  const id = Number(
    db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run('leo@atelier.fr', await hashPassword('motdepasse1'), nowIso()).lastInsertRowid,
  );
  const here = `sid=${createSession(db, id)}`;
  const other = `sid=${createSession(db, id)}`;
  assert.equal((await call(here, 'PUT', '/api/me/password', { current: 'faux', next: 'nouveau-mdp-1' })).status, 403);
  assert.equal((await call(here, 'PUT', '/api/me/password', { current: 'motdepasse1', next: 'court' })).status, 400);
  assert.equal((await call(here, 'PUT', '/api/me/password', { current: 'motdepasse1', next: 'nouveau-mdp-1' })).status, 200);
  assert.equal((await call(here, 'GET', '/api/me')).data.user.email, 'leo@atelier.fr');
  assert.equal((await call(other, 'GET', '/api/me')).data.user, null);
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'leo@atelier.fr', password: 'nouveau-mdp-1' }),
  });
  assert.equal(login.status, 200);
});

test('export RGPD : les données de l’utilisateur, et seulement les siennes', async () => {
  const id = (db.prepare('SELECT id FROM users WHERE email = ?').get('nina@studio.fr') as { id: number }).id;
  const res = await fetch(`${base}/api/me/export`, { headers: { cookie: `sid=${createSession(db, id)}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="mes-donnees-sitolead-/);
  const data = (await res.json()) as ReturnType<typeof exportUserData>;
  assert.equal(data.account.email, 'nina@studio.fr');
  assert.equal(data.credits.length, 1);
  assert.ok(!JSON.stringify(data).includes('leo@atelier.fr'));
  assert.ok(!JSON.stringify(data).includes('pass_hash'));
});

test('sauvegarde : copie cohérente du jour, 14 conservées', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sitolead-backup-'));
  try {
    for (let d = 1; d <= 16; d++) writeFileSync(join(dir, `sitolead-2026-01-${String(d).padStart(2, '0')}.db`), '');
    const file = backupDatabase(db, dir, 14, new Date('2026-02-01T10:00:00Z'));
    assert.ok(existsSync(file));
    const left = readdirSync(dir).sort();
    assert.equal(left.length, 14);
    assert.equal(left.at(-1), 'sitolead-2026-02-01.db');
    assert.ok(!left.includes('sitolead-2026-01-01.db'));
    const copy = openDatabase(file);
    assert.ok(Number(copy.prepare('SELECT COUNT(*) AS n FROM users').get()!.n) >= 3);
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
