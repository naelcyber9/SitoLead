// Comptes : mots de passe scrypt, sessions opaques stockées hachées en base.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { nowIso, type DB } from './db.ts';
import type { UserRow } from './billing.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, salt, key] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(got, expected);
}

export function validatePassword(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < 8) return 'Mot de passe : 8 caractères minimum';
  if (pw.length > 200) return 'Mot de passe trop long';
  return null;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: DB, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(token), userId, nowIso(), expires);
  return token;
}

export function userBySession(db: DB, token: string | undefined): UserRow | null {
  if (!token || token.length > 100) return null;
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sha(token), nowIso()) as UserRow | undefined;
  return row ?? null;
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

/** Limiteur simple en mémoire (fenêtre glissante) pour la connexion / l'inscription. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}
