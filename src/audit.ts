// Audit d'un site existant : détecte ce qui fait perdre des clients au prospect.
// `analyzeSite` est pur (testable) ; `fetchSite` va chercher la page en se
// protégeant des requêtes vers le réseau interne (SSRF).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type SiteStatus = 'none' | 'social' | 'ok' | 'weak' | 'down' | 'unknown' | 'pending';

export interface AuditIssue {
  code: string;
  label: string;
  /** Points perdus sur 100. */
  weight: number;
}

export interface FetchedSite {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  html: string;
  ms: number;
}

export interface AuditResult {
  status: SiteStatus;
  score: number | null;
  issues: AuditIssue[];
}

const SOCIAL_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linktr\.ee|tiktok\.com|pagesjaunes\.fr|business\.site|g\.page|google\.com|tripadvisor\.[a-z.]+|thefork\.[a-z.]+|lafourchette\.com|doctolib\.fr|planity\.com)$/i;
const FREE_SUBDOMAINS = /\.(wixsite\.com|jimdofree\.com|jimdo\.com|webnode\.(fr|com)|e-monsite\.com|over-blog\.com|blogspot\.com|wordpress\.com|site123\.me|sitew\.fr|strikingly\.com|weebly\.com)$/i;

/** Classe une URL déclarée : pas de site, simple page de réseau social / annuaire, ou vrai site. */
export function classifyWebsite(url: string | null | undefined): 'none' | 'social' | 'site' {
  if (!url || !url.trim()) return 'none';
  try {
    const u = new URL(normalizeUrl(url));
    return SOCIAL_HOSTS.test(u.hostname) ? 'social' : 'site';
  } catch {
    return 'none';
  }
}

export function normalizeUrl(url: string): string {
  const t = url.trim();
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

const pick = (html: string, re: RegExp) => re.exec(html)?.[1]?.trim() ?? '';

export function analyzeSite(site: FetchedSite, now = new Date()): AuditResult {
  if (site.status === 0 || site.status >= 400) {
    return {
      status: 'down',
      score: 0,
      issues: [{ code: 'down', label: site.status ? `Le site renvoie une erreur ${site.status}` : 'Le site ne répond pas', weight: 100 }],
    };
  }
  const html = site.html;
  const lower = html.toLowerCase();
  const issues: AuditIssue[] = [];
  const add = (code: string, label: string, weight: number) => issues.push({ code, label, weight });

  let host = '';
  try {
    const u = new URL(site.finalUrl);
    host = u.hostname;
    if (u.protocol !== 'https:') add('no_https', 'Pas de HTTPS : Chrome affiche « Non sécurisé »', 20);
  } catch {
    /* URL déjà validée en amont */
  }
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) add('no_mobile', 'Pas adapté au mobile (aucune balise viewport)', 20);

  const title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title.length < 10) add('no_title', title ? `Titre de page trop court (« ${title.slice(0, 40)} »)` : 'Aucun titre de page pour Google', 10);
  if (!/<meta[^>]+name=["']?description["']?[^>]+content=["'][^"']{30,}/i.test(html) && !/<meta[^>]+content=["'][^"']{30,}["'][^>]+name=["']?description/i.test(html)) {
    add('no_description', 'Pas de description pour les résultats Google', 8);
  }
  if (!/<h1[\s>]/i.test(html)) add('no_h1', 'Aucun titre principal (H1) sur la page', 5);
  if (site.ms > 3500) add('slow', `Chargement lent (${(site.ms / 1000).toFixed(1)} s)`, 12);
  else if (site.ms > 2000) add('slowish', `Chargement moyen (${(site.ms / 1000).toFixed(1)} s)`, 5);

  const years = [...lower.matchAll(/(?:©|&copy;|copyright)\s*(?:[^<\d]{0,30})?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/g)].map((m) =>
    Number(m[2] ?? m[1]),
  );
  const lastYear = years.length ? Math.max(...years) : null;
  if (lastYear !== null && lastYear <= now.getFullYear() - 3) add('outdated', `Site pas mis à jour depuis ${lastYear}`, 12);

  if (FREE_SUBDOMAINS.test(host)) add('free_host', `Hébergé sur un sous-domaine gratuit (${host})`, 12);
  if (/<embed[^>]+\.swf|<object[^>]+flash/i.test(html)) add('flash', 'Utilise Flash (plus lu par aucun navigateur)', 15);
  if (!/href=["']tel:/i.test(html)) add('no_tel', 'Pas de bouton d’appel cliquable sur mobile', 5);
  if (!/application\/ld\+json/i.test(html)) add('no_schema', 'Pas de données structurées pour Google Maps / fiche locale', 5);
  if (!/<form[\s>]/i.test(html) && !/mailto:/i.test(html) && !/calendly|planity|doctolib|zenchef|thefork|resa/i.test(lower)) {
    add('no_contact', 'Aucun formulaire de contact ni prise de rendez-vous', 8);
  }
  if (html.length < 1500) add('thin', 'Page quasi vide (moins de 1 500 caractères)', 8);

  const score = Math.max(0, 100 - issues.reduce((s, i) => s + i.weight, 0));
  return { status: score < 70 ? 'weak' : 'ok', score, issues: issues.sort((a, b) => b.weight - a.weight) };
}

// --- Récupération sécurisée -------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Hôte interne refusé');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adresse privée refusée');
}

const MAX_HTML = 1_500_000;

export async function fetchSite(rawUrl: string, timeoutMs = 9000): Promise<FetchedSite> {
  const requestedUrl = normalizeUrl(rawUrl);
  let url = requestedUrl;
  const started = performance.now();
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Protocole refusé');
    if (u.port && !['80', '443', '8080'].includes(u.port)) throw new Error('Port refusé');
    await assertPublicHost(u.hostname);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; SitoleadAudit/1.0)', accept: 'text/html,*/*;q=0.5' },
      });
    } catch {
      return { requestedUrl, finalUrl: url, status: 0, html: '', ms: performance.now() - started };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url).toString();
      await res.body?.cancel();
      continue;
    }
    let html = '';
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        html += dec.decode(value, { stream: true });
        if (size > MAX_HTML) {
          await reader.cancel();
          break;
        }
      }
    }
    return { requestedUrl, finalUrl: url, status: res.status, html, ms: performance.now() - started };
  }
  return { requestedUrl, finalUrl: url, status: 0, html: '', ms: performance.now() - started };
}

export async function auditWebsite(url: string): Promise<AuditResult> {
  try {
    return analyzeSite(await fetchSite(url));
  } catch (e) {
    return { status: 'unknown', score: null, issues: [{ code: 'blocked', label: `Audit impossible : ${(e as Error).message}`, weight: 0 }] };
  }
}
