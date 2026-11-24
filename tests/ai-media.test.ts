// Rédaction IA (sans aucun appel réel : générateur simulé) et images des maquettes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isUnverifiable, stripClaims, suggestTexts, type Generate } from '../src/ai.ts';
import { createSession } from '../src/auth.ts';
import type { UserRow } from '../src/billing.ts';
import { openDatabase, nowIso } from '../src/db.ts';
import { sniffImage, stripJpegMetadata } from '../src/media.ts';
import { upsertProspects } from '../src/prospects.ts';
import { createApp } from '../src/server.ts';

const uploads = mkdtempSync(join(tmpdir(), 'sitolead-uploads-'));
process.env.UPLOAD_DIR = uploads;
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-faux';
process.env.AI_DAILY_BUDGET_USD = '0.05';

function makeUser(db: ReturnType<typeof openDatabase>, email: string): UserRow {
  const r = db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run(email, 'x', nowIso());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as UserRow;
}

const input = { name: 'Plomberie du Lac', tradeLabel: 'Plombier', city: 'Annecy', area: '', services: [], about: '', tone: 'professionnel' as const };

// --- IA ------------------------------------------------------------------------------------

test('filtre des affirmations invérifiables', () => {
  for (const s of ['Plus de 20 ans d’expérience', 'Depuis 1998', 'Devis gratuit', 'Artisan certifié RGE', '4,9 étoiles sur Google', 'Intervention 24h/24 et 7j/7', 'Le meilleur plombier', 'Travail garanti', 'Intervention en moins de 30 minutes', 'Tarifs à partir de 50 €']) {
    assert.ok(isUnverifiable(s), s);
  }
  for (const s of ['Dépannage et recherche de fuite', 'Votre plombier à Annecy', 'Contactez-nous pour décrire votre besoin']) {
    assert.ok(!isUnverifiable(s), s);
  }
  assert.equal(
    stripClaims('Plomberie du Lac intervient à Annecy. Fort de 20 ans d’expérience, nous garantissons nos travaux. Contactez-nous.'),
    'Plomberie du Lac intervient à Annecy. Contactez-nous.',
  );
});

test('rédaction IA : suggestion filtrée, coût enregistré, quota mensuel et plafond quotidien respectés', async () => {
  const db = openDatabase(':memory:');
  const u = makeUser(db, 'a@b.fr');
  let calls = 0;
  const fake: Generate = async () => {
    calls++;
    return {
      inputTokens: 600,
      outputTokens: 300,
      refused: false,
      suggestion: {
        tagline: 'Votre plombier à Annecy',
        about: 'Plomberie du Lac intervient à Annecy. Plus de 15 ans d’expérience à votre service. Contactez-nous.',
        services: ['Dépannage', 'Devis gratuit', 'Chauffe-eau'],
        cta: 'Demander une intervention',
      },
    };
  };
  const r = await suggestTexts(db, u, input, fake);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.suggestion.about, 'Plomberie du Lac intervient à Annecy. Contactez-nous.');
  assert.deepEqual(r.suggestion.services, ['Dépannage', 'Chauffe-eau']);
  assert.ok(r.costUsd > 0);
  // Offre gratuite : 3 rédactions par mois
  await suggestTexts(db, u, input, fake);
  await suggestTexts(db, u, input, fake);
  const q = await suggestTexts(db, u, input, fake);
  assert.equal(q.ok, false);
  if (!q.ok) assert.equal(q.reason, 'quota');
  assert.equal(calls, 3);
  // Plafond quotidien global (0,05 $ ici) : une fois atteint, plus aucun appel, pour personne
  const v = makeUser(db, 'c@d.fr');
  db.prepare('INSERT INTO ai_usage (user_id, created_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, 0, 0, 1)').run(u.id, nowIso());
  const b = await suggestTexts(db, v, input, fake);
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.reason, 'budget');
  assert.equal(calls, 3);
});

test('rédaction IA désactivée sans clé', async () => {
  const db = openDatabase(':memory:');
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r = await suggestTexts(db, makeUser(db, 'a@b.fr'), input, async () => {
    throw new Error('ne doit pas être appelé');
  });
  process.env.ANTHROPIC_API_KEY = saved;
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'disabled');
});

// --- Images ------------------------------------------------------------------------------

// JPEG minimal : SOI + APP1 (EXIF avec « GPS ») + APP0 + SOS + données + EOI
const exif = Buffer.from('Exif\0\0GPS-48.85-2.35');
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.from([0xff, 0xe1]), Buffer.from([0, exif.length + 2]), exif,
  Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]),
  Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33]),
  Buffer.from([0xff, 0xd9]),
]);

test('images : type réel vérifié, métadonnées EXIF retirées', () => {
  assert.equal(sniffImage(jpeg), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(sniffImage(Buffer.from('GIF89a......')), null);
  const clean = stripJpegMetadata(jpeg);
  assert.ok(!clean.includes(Buffer.from('GPS')));
  assert.ok(clean.includes(Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0x33])));
});

const db = openDatabase(':memory:');
let server: Server;
let base = '';
let cookie = '';
before(async () => {
  upsertProspects(
    db,
    [{ id: 'osm:node/1', source: 'osm', siret: null, name: 'Plomberie du Lac', address: null, postal_code: '74000', city: 'Annecy', lat: null, lon: null, phone: '0450', email: null, website: null, created_on: null }],
    'plombier',
    '74010',
  );
  const fake: Generate = async () => ({
    inputTokens: 10,
    outputTokens: 10,
    refused: false,
    suggestion: { tagline: 'Votre plombier à Annecy', about: 'Texte.', services: ['Dépannage'], cta: 'Nous contacter' },
  });
  const handler = createApp({ db, appUrl: 'https://sitolead.test', live: false, ai: fake });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(uploads, { recursive: true, force: true });
});

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
    /* binaire ou HTML */
  }
  return { status: res.status, data, headers: res.headers };
}

test('API : envoi d’image, affichage dans la maquette, propriété vérifiée, IA proposée sans enregistrement', async () => {
  const nina = makeUser(db, 'nina@studio.fr');
  cookie = `sid=${createSession(db, nina.id)}`;
  assert.equal((await call('POST', '/api/media', { data: Buffer.from('<svg/>').toString('base64') })).status, 400);
  const up = await call('POST', '/api/media', { data: jpeg.toString('base64') });
  assert.equal(up.status, 201);
  const img = await fetch(`${base}/media/${up.data.id}`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(!Buffer.from(await img.arrayBuffer()).includes(Buffer.from('GPS')));

  await call('POST', '/api/prospects/osm%3Anode%2F1/unlock', {});
  const m = (await call('POST', '/api/mockups', { prospect_id: 'osm:node/1' })).data.mockup;
  const saved = await call('PATCH', `/api/mockups/${m.id}`, { data: { ...m.data, photo: up.data.id } });
  assert.equal(saved.data.mockup.data.photo, up.data.id);
  assert.match((await call('GET', `/p/${m.id}`)).data, new RegExp(`/media/${up.data.id}`));

  // IA : suggestion renvoyée à l'éditeur, maquette inchangée tant qu'on n'enregistre pas
  const ai = await call('POST', `/api/mockups/${m.id}/ia`, { tone: 'chaleureux' });
  assert.equal(ai.status, 200);
  assert.equal(ai.data.suggestion.tagline, 'Votre plombier à Annecy');
  assert.equal((await call('GET', `/api/mockups/${m.id}`)).data.mockup.data.about, m.data.about);

  // Un autre compte ne peut ni utiliser ni supprimer l'image de Nina
  const leo = makeUser(db, 'leo@atelier.fr');
  cookie = `sid=${createSession(db, leo.id)}`;
  await call('POST', '/api/prospects/osm%3Anode%2F1/unlock', {});
  const lm = (await call('POST', '/api/mockups', { prospect_id: 'osm:node/1' })).data.mockup;
  const stolen = await call('PATCH', `/api/mockups/${lm.id}`, { data: { ...lm.data, logo: up.data.id } });
  assert.equal(stolen.data.mockup.data.logo, '');
  assert.equal((await call('DELETE', `/api/media/${up.data.id}`, {})).status, 404);
  assert.equal((await call('POST', `/api/mockups/${m.id}/ia`, {})).status, 404);
});
