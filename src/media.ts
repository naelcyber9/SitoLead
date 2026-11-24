// Images des maquettes (logo, photo) : stockées sur le disque du serveur, sans service payant.
// Contrôles : type réel vérifié sur le contenu (pas seulement l'extension), taille plafonnée,
// nombre d'images par compte limité, métadonnées EXIF des JPEG retirées (elles peuvent
// contenir la position GPS de la prise de vue). Les fichiers sont servis sous un nom aléatoire.

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectivePlan, type UserRow } from './billing.ts';
import { nowIso, type DB } from './db.ts';

export const MAX_IMAGE_BYTES = 1_500_000;
/** Images conservées par compte selon l'offre. */
export const MEDIA_LIMIT: Record<string, number> = { free: 6, pro: 400, agence: 1500 };

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;

const uploadDir = () => process.env.UPLOAD_DIR || 'data/uploads';

/** Type réel d'après les premiers octets (signature du format). */
export function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Retire les segments APP1 (EXIF / XMP) d'un JPEG, sans toucher à l'image elle-même. */
export function stripJpegMetadata(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!;
    if (marker === 0xda) break; // début des données de l'image : on recopie tout le reste
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b; // fichier atypique : on ne le modifie pas
    if (marker !== 0xe1) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

export function mediaQuota(db: DB, u: UserRow): { limit: number; used: number; remaining: number } {
  const limit = MEDIA_LIMIT[effectivePlan(u).id] ?? 0;
  const used = Number((db.prepare('SELECT COUNT(*) AS n FROM media WHERE user_id = ?').get(u.id) as { n: number }).n);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export type SaveResult = { ok: true; id: string } | { ok: false; message: string };

export async function saveImage(db: DB, u: UserRow, data: Buffer): Promise<SaveResult> {
  if (data.length === 0) return { ok: false, message: 'Fichier vide' };
  if (data.length > MAX_IMAGE_BYTES) return { ok: false, message: 'Image trop lourde (1,5 Mo maximum) : réduisez-la avant de l’envoyer' };
  const mime = sniffImage(data);
  if (!mime) return { ok: false, message: 'Format non accepté : JPEG, PNG ou WebP uniquement' };
  if (mediaQuota(db, u).remaining <= 0) return { ok: false, message: 'Nombre maximal d’images atteint pour votre offre : supprimez-en ou changez d’offre' };
  const body = mime === 'image/jpeg' ? stripJpegMetadata(data) : data;
  const id = randomBytes(16).toString('base64url');
  mkdirSync(uploadDir(), { recursive: true });
  await writeFile(join(uploadDir(), `${id}.${EXT[mime]}`), body);
  db.prepare('INSERT INTO media (id, user_id, mime, size, created_at) VALUES (?, ?, ?, ?, ?)').run(id, u.id, mime, body.length, nowIso());
  return { ok: true, id };
}

export async function readMedia(db: DB, id: string): Promise<{ mime: string; data: Buffer } | null> {
  if (!MEDIA_ID.test(id)) return null;
  const row = db.prepare('SELECT mime FROM media WHERE id = ?').get(id) as { mime: string } | undefined;
  if (!row) return null;
  try {
    return { mime: row.mime, data: await readFile(join(uploadDir(), `${id}.${EXT[row.mime]}`)) };
  } catch {
    return null;
  }
}

export const ownsMedia = (db: DB, userId: number, id: string): boolean =>
  MEDIA_ID.test(id) && Boolean(db.prepare('SELECT 1 FROM media WHERE id = ? AND user_id = ?').get(id, userId));

export const listMedia = (db: DB, userId: number) =>
  db.prepare('SELECT id, mime, size, created_at FROM media WHERE user_id = ? ORDER BY created_at DESC').all(userId) as {
    id: string;
    mime: string;
    size: number;
    created_at: string;
  }[];

export async function deleteMedia(db: DB, userId: number, id: string): Promise<boolean> {
  const row = db.prepare('SELECT mime FROM media WHERE id = ? AND user_id = ?').get(id, userId) as { mime: string } | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
  await unlink(join(uploadDir(), `${id}.${EXT[row.mime]}`)).catch(() => {});
  return true;
}

/** Suppression de compte : les fichiers partent avec (la base les supprime par cascade). */
export async function deleteAllMedia(db: DB, userId: number): Promise<void> {
  for (const m of listMedia(db, userId)) await deleteMedia(db, userId, m.id);
}
