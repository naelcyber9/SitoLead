// Serveur HTTP sans dépendance : pages SEO, application (/app), API JSON et webhook Stripe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EMAIL_RE, RateLimiter, createSession, destroySession, hashPassword, purgeExpiredSessions, userBySession, validatePassword, verifyPassword, SESSION_DAYS,
} from './auth.ts';
import {
  PLANS, createCheckout, createPortal, effectivePlan, handleStripeEvent, quotaFor, stripeConfigured, verifyStripeSignature, type UserRow,
} from './billing.ts';
import { CITIES, TRADES, cityByCode, cityBySlug, tradeBySlug } from './catalog.ts';
import { nowIso, openDatabase, type DB } from './db.ts';
import {
  LEAD_STATUSES, cityStats, getLead, isSearching, leadsCsv, listLeads, listProspects, refreshSearch, scheduleAudits, searchInfo, unlockProspect, updateLead,
} from './prospects.ts';

/** Temps maximal d'attente des sources avant de renvoyer des résultats partiels. */
const SEARCH_WAIT_MS = 3000;
import { buildPitch } from './scoring.ts';
import * as seo from './seo.ts';
import { communeByCode, searchCommunes, type Commune } from './sources.ts';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export interface AppOptions {
  db: DB;
  appUrl: string;
  /** Appels aux sources en ligne (OpenStreetMap, SIRENE, geo.api.gouv.fr). */
  live: boolean;
  /** Remplaçable dans les tests. */
  checkout?: typeof createCheckout;
  portal?: typeof createPortal;
}

class HttpError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}) =>
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'cache-control': 'no-store', ...extra });
const html = (res: ServerResponse, status: number, body: string) =>
  send(res, status, body, 'text/html; charset=utf-8', { 'cache-control': 'public, max-age=300' });

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 64 * 1024);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* plus bas */
  }
  throw new HttpError(400, 'JSON invalide');
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* cookie mal formé ignoré */
      }
    }
  }
  return out;
}

function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? '?';
}

function publicUser(db: DB, u: UserRow) {
  const plan = effectivePlan(u);
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    agency_name: u.agency_name,
    phone: u.phone,
    website: u.website,
    plan: plan.id,
    planName: plan.name,
    plan_status: u.plan_status,
    period_end: u.period_end,
    csv: plan.csv,
    hasBilling: Boolean(u.stripe_customer_id),
    quota: quotaFor(db, u),
  };
}

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t || null;
};

export function createApp(opts: AppOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { db, appUrl, live } = opts;
  const checkout = opts.checkout ?? createCheckout;
  const portal = opts.portal ?? createPortal;
  const authLimiter = new RateLimiter(10, 15 * 60_000);
  const searchLimiter = new RateLimiter(40, 60_000);
  const communeLimiter = new RateLimiter(120, 60_000);
  const appOrigin = new URL(appUrl).origin;
  const secureCookie = appUrl.startsWith('https://');
  const communes = new Map<string, Commune>();

  const sessionCookie = (token: string, maxAge: number) =>
    `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;

  async function resolveCommune(code: string): Promise<Commune> {
    if (!/^[0-9][0-9AB][0-9]{3}$/i.test(code)) throw new HttpError(400, 'Commune invalide');
    const cached = communes.get(code);
    if (cached) return cached;
    const known = cityByCode(code);
    let c: Commune | null = known ? { code, nom: known.name, departement: known.dep, population: 0, codesPostaux: [] } : null;
    if (!c && live) c = await communeByCode(code);
    if (!c) {
      const prev = db.prepare('SELECT city_name FROM searches WHERE city_code = ? LIMIT 1').get(code) as { city_name: string } | undefined;
      if (prev) c = { code, nom: prev.city_name, departement: code.slice(0, 2), population: 0, codesPostaux: [] };
    }
    if (!c) throw new HttpError(404, 'Commune introuvable');
    if (communes.size > 5000) communes.clear();
    communes.set(code, c);
    return c;
  }

  function requireUser(req: IncomingMessage): UserRow {
    const u = userBySession(db, cookies(req).sid);
    if (!u) throw new HttpError(401, 'Connectez-vous pour continuer');
    return u;
  }

  /** Protection CSRF : JSON obligatoire (pas de formulaire inter-sites possible) + Origin vérifiée. */
  function checkCsrf(req: IncomingMessage): void {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.startsWith('application/json')) throw new HttpError(415, 'Content-Type application/json attendu');
    const origin = req.headers.origin;
    if (origin && origin !== appOrigin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
      throw new HttpError(403, 'Origine refusée');
    }
  }

  async function serveStatic(res: ServerResponse, rel: string, cache: string): Promise<boolean> {
    const full = normalize(join(WEB_DIR, rel));
    if (!full.startsWith(normalize(WEB_DIR)) || full.includes(`${sep}..`)) return false;
    try {
      const data = await readFile(full);
      send(res, 200, data, MIME[extname(full)] ?? 'application/octet-stream', { 'cache-control': cache });
      return true;
    } catch {
      return false;
    }
  }

  function indexableCityTrades(): { city: string; trade: string }[] {
    const rows = db.prepare('SELECT city_code, trade, COUNT(*) AS n FROM prospects GROUP BY city_code, trade HAVING n >= 3').all() as {
      city_code: string;
      trade: string;
    }[];
    return rows.flatMap((r) => {
      const c = cityByCode(r.city_code);
      return c && tradeBySlug(r.trade) ? [{ city: c.slug, trade: r.trade }] : [];
    });
  }

  // --- API ---------------------------------------------------------------------------

  async function api(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], url: URL): Promise<void> {
    const route = `${method} /${parts.join('/')}`;
    const mutating = method !== 'GET';

    if (route === 'POST /api/stripe/webhook') {
      const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
      const raw = await readBody(req, 1024 * 1024);
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'] as string | undefined, secret)) throw new HttpError(400, 'Signature invalide');
      const result = handleStripeEvent(db, JSON.parse(raw));
      return json(res, 200, { received: true, result });
    }

    if (mutating) checkCsrf(req);

    switch (route) {
      case 'GET /api/config':
        return json(res, 200, {
          plans: Object.values(PLANS),
          trades: TRADES.map((t) => ({ slug: t.slug, label: t.label, plural: t.plural })),
          cities: CITIES.map((c) => ({ code: c.code, name: c.name, dep: c.dep })),
          leadStatuses: LEAD_STATUSES,
          billing: stripeConfigured(),
        });

      case 'POST /api/signup':
      case 'POST /api/login': {
        if (!authLimiter.allow(clientIp(req))) throw new HttpError(429, 'Trop de tentatives, réessayez dans quelques minutes');
        const body = await readJson(req);
        const email = String(body.email ?? '').trim().toLowerCase();
        const password = body.password;
        if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Adresse email invalide');
        let userId: number;
        if (route === 'POST /api/signup') {
          const err = validatePassword(password);
          if (err) throw new HttpError(400, err);
          if (body.terms !== true) throw new HttpError(400, 'Acceptez les conditions générales pour continuer');
          const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
          if (exists) throw new HttpError(409, 'Un compte existe déjà avec cet email : connectez-vous');
          const r = db.prepare('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run(email, await hashPassword(String(password)), nowIso());
          userId = Number(r.lastInsertRowid);
        } else {
          const row = db.prepare('SELECT id, pass_hash FROM users WHERE email = ?').get(email) as { id: number; pass_hash: string } | undefined;
          // Même coût de calcul que le compte existe ou non (pas d'énumération par le temps de réponse).
          const ok = await verifyPassword(String(password ?? ''), row?.pass_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
          if (!row || !ok) throw new HttpError(401, 'Email ou mot de passe incorrect');
          userId = row.id;
        }
        const token = createSession(db, userId);
        const u = userBySession(db, token)!;
        return json(res, route === 'POST /api/signup' ? 201 : 200, { user: publicUser(db, u) }, { 'set-cookie': sessionCookie(token, SESSION_DAYS * 86_400) });
      }

      case 'POST /api/logout':
        destroySession(db, cookies(req).sid);
        return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });

      case 'GET /api/me': {
        const u = userBySession(db, cookies(req).sid);
        return json(res, 200, { user: u ? publicUser(db, u) : null });
      }

      case 'PATCH /api/me': {
        const u = requireUser(req);
        const b = await readJson(req);
        const website = str(b.website, 200);
        if (website && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(website)) throw new HttpError(400, 'Site web : adresse complète attendue (https://…)');
        db.prepare('UPDATE users SET full_name = ?, agency_name = ?, phone = ?, website = ? WHERE id = ?').run(
          str(b.full_name, 100), str(b.agency_name, 100), str(b.phone, 30), website, u.id,
        );
        return json(res, 200, { user: publicUser(db, requireUser(req)) });
      }

      case 'DELETE /api/me': {
        const u = requireUser(req);
        const b = await readJson(req);
        const row = db.prepare('SELECT pass_hash FROM users WHERE id = ?').get(u.id) as { pass_hash: string };
        if (!(await verifyPassword(String(b.password ?? ''), row.pass_hash))) throw new HttpError(403, 'Mot de passe incorrect');
        if (effectivePlan(u).id !== 'free' && u.plan_status !== 'canceled') {
          throw new HttpError(409, 'Résiliez d’abord votre abonnement (rubrique Abonnement), puis supprimez votre compte');
        }
        db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
      }

      case 'GET /api/communes': {
        if (!communeLimiter.allow(clientIp(req))) throw new HttpError(429, 'Trop de requêtes');
        const q = url.searchParams.get('q') ?? '';
        const local = CITIES.filter((c) => c.name.toLowerCase().startsWith(q.trim().toLowerCase())).map((c) => ({ code: c.code, nom: c.name, departement: c.dep }));
        if (!live) return json(res, 200, { items: local.slice(0, 8) });
        try {
          const items = await searchCommunes(q);
          return json(res, 200, { items: items.map((c) => ({ code: c.code, nom: c.nom, departement: c.departement, codesPostaux: c.codesPostaux.slice(0, 3) })) });
        } catch {
          return json(res, 200, { items: local.slice(0, 8), degraded: true });
        }
      }

      case 'GET /api/prospects': {
        const u = requireUser(req);
        if (!searchLimiter.allow(`u${u.id}`)) throw new HttpError(429, 'Trop de recherches, patientez une minute');
        const commune = await resolveCommune(url.searchParams.get('city') ?? '');
        const trade = url.searchParams.get('trade') ?? '';
        if (!tradeBySlug(trade)) throw new HttpError(400, 'Métier inconnu');
        const status = url.searchParams.get('status');
        const minScore = Number(url.searchParams.get('min') ?? 0) || 0;
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
        let info = searchInfo(db, commune.code, trade);
        if (live) {
          if (!info || (info.errors.length && info.found === 0)) {
            // On n'attend pas les sources lentes : au-delà de quelques secondes, on renvoie ce qui
            // est déjà enregistré et l'écran redemande tant que `pending` est vrai.
            const job = refreshSearch(db, commune, trade, { live, force: Boolean(info) });
            job.catch(() => {});
            const done = await Promise.race([job.catch(() => null), new Promise<null>((r) => setTimeout(r, SEARCH_WAIT_MS, null))]);
            info = done ?? searchInfo(db, commune.code, trade);
          } else if (!info.fresh) void refreshSearch(db, commune, trade, { live }).catch(() => {});
          if (isSearching(commune.code, trade)) info = { ...(info ?? { fetched_at: null, found: 0, errors: [], fresh: false }), pending: true };
        }
        const list = listProspects(db, u.id, {
          cityCode: commune.code,
          trade,
          status: status === 'nosite' || status === 'weak' || status === 'recent' ? status : 'all',
          minScore,
          limit: 50,
          offset,
        });
        return json(res, 200, { commune: { code: commune.code, nom: commune.nom }, search: info, quota: quotaFor(db, u), ...list });
      }

      case 'GET /api/leads': {
        const u = requireUser(req);
        return json(res, 200, { items: listLeads(db, u.id), quota: quotaFor(db, u) });
      }

      case 'GET /api/leads.csv': {
        const u = requireUser(req);
        if (!effectivePlan(u).csv) throw new HttpError(402, 'L’export CSV est inclus dans les offres Pro et Agence', 'upgrade');
        const day = new Date().toISOString().slice(0, 10);
        return send(res, 200, leadsCsv(listLeads(db, u.id)), 'text/csv; charset=utf-8', {
          'content-disposition': `attachment; filename="prospects-sitolead-${day}.csv"`,
          'cache-control': 'no-store',
        });
      }

      case 'POST /api/billing/checkout': {
        const u = requireUser(req);
        if (!stripeConfigured()) throw new HttpError(503, 'Le paiement n’est pas encore configuré sur ce serveur');
        const plan = (await readJson(req)).plan;
        if (plan !== 'pro' && plan !== 'agence') throw new HttpError(400, 'Offre inconnue');
        const active = effectivePlan(u);
        if (active.id !== 'free' && u.stripe_customer_id) {
          return json(res, 200, { url: await portal(u, appUrl) });
        }
        return json(res, 200, { url: await checkout(u, plan, appUrl) });
      }

      case 'POST /api/billing/portal': {
        const u = requireUser(req);
        if (!stripeConfigured()) throw new HttpError(503, 'Le paiement n’est pas encore configuré sur ce serveur');
        return json(res, 200, { url: await portal(u, appUrl) });
      }
    }

    // Routes avec paramètre : /api/prospects/:id/unlock, /api/leads/:id, /api/leads/:id/pitch
    if (parts[1] === 'prospects' && parts.length === 4 && parts[3] === 'unlock' && method === 'POST') {
      const u = requireUser(req);
      const r = unlockProspect(db, u, parts[2]!);
      if (!r.ok && r.reason === 'not_found') throw new HttpError(404, 'Entreprise introuvable');
      if (!r.ok) {
        const plan = effectivePlan(u);
        throw new HttpError(
          402,
          plan.monthly
            ? `Vous avez débloqué vos ${plan.unlocks} entreprises du mois. Passez à l’offre supérieure ou attendez le 1er du mois.`
            : 'Vos entreprises offertes sont utilisées. Passez à l’offre Pro pour continuer à trouver des clients.',
          'upgrade',
        );
      }
      return json(res, 200, { prospect: r.prospect, already: r.already, quota: quotaFor(db, u) });
    }
    if (parts[1] === 'leads' && parts.length >= 3) {
      const u = requireUser(req);
      const id = parts[2]!;
      if (parts.length === 3 && method === 'GET') {
        const lead = getLead(db, u.id, id);
        if (!lead) throw new HttpError(404, 'Prospect non débloqué');
        return json(res, 200, { lead });
      }
      if (parts.length === 3 && method === 'PATCH') {
        const lead = updateLead(db, u.id, id, await readJson(req));
        if (!lead) throw new HttpError(404, 'Prospect non débloqué');
        return json(res, 200, { lead });
      }
      if (parts.length === 4 && parts[3] === 'pitch' && method === 'GET') {
        const lead = getLead(db, u.id, id);
        if (!lead) throw new HttpError(404, 'Prospect non débloqué');
        const pitch = buildPitch(
          { ...lead, audit_issues: lead.issues },
          { full_name: u.full_name, agency_name: u.agency_name, phone: u.phone, website: u.website, email: u.email },
        );
        return json(res, 200, { pitch, profileComplete: Boolean(u.full_name && (u.phone || u.website)) });
      }
    }
    throw new HttpError(404, 'Route inconnue');
  }

  // --- Pages ---------------------------------------------------------------------------

  async function page(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
    const [a, b, c] = parts;
    if (parts.length === 0) {
      const t = db.prepare(`SELECT COUNT(*) AS n, SUM(site_status IN ('none','social','down','unknown')) AS nosite FROM prospects`).get() as {
        n: number;
        nosite: number | null;
      };
      return html(res, 200, seo.homePage(appUrl, { prospects: Number(t.n), nosite: Number(t.nosite ?? 0) }));
    }
    if (a === 'tarifs' && parts.length === 1) return html(res, 200, seo.pricingPage(appUrl));
    if (a === 'mentions-legales' && parts.length === 1) return html(res, 200, seo.legalNoticePage(appUrl));
    if (a === 'cgv' && parts.length === 1) return html(res, 200, seo.termsPage(appUrl));
    if (a === 'confidentialite' && parts.length === 1) return html(res, 200, seo.privacyPage(appUrl));
    if (a === 'robots.txt') return send(res, 200, seo.robotsTxt(appUrl), 'text/plain; charset=utf-8');
    if (a === 'sitemap.xml') return send(res, 200, seo.sitemapXml(appUrl, indexableCityTrades()), 'application/xml; charset=utf-8');
    if (a === 'prospection') {
      if (!b) return html(res, 200, seo.citiesIndexPage(appUrl));
      const city = cityBySlug(b);
      if (city && !c) return html(res, 200, seo.cityPage(appUrl, city, cityStats(db, city.code)));
      const trade = c ? tradeBySlug(c) : undefined;
      if (city && trade && parts.length === 3) return html(res, 200, seo.cityTradePage(appUrl, city, trade, cityStats(db, city.code)));
    }
    if (a === 'metiers' && b && parts.length === 2) {
      const trade = tradeBySlug(b);
      if (trade) return html(res, 200, seo.tradePage(appUrl, trade));
    }
    if (a === 'app' && parts.length === 1) {
      if (await serveStatic(res, 'app.html', 'no-cache')) return;
    }
    if (a === 'assets' && b && parts.length === 2) {
      if (await serveStatic(res, b, 'public, max-age=3600')) return;
    }
    if (a === 'favicon.ico') {
      res.writeHead(301, { location: '/assets/favicon.svg' });
      return void res.end();
    }
    void req;
    send(res, 404, seo.notFoundPage(appUrl), 'text/html; charset=utf-8');
  }

  return async (req, res) => {
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://x');
    } catch {
      return send(res, 400, 'Requête invalide', 'text/plain; charset=utf-8');
    }
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return send(res, 400, 'Requête invalide', 'text/plain; charset=utf-8');
    }
    try {
      if (parts[0] === 'api') return await api(req, res, method, parts, url);
      if (method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
      if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
        res.writeHead(301, { location: url.pathname.replace(/\/+$/, '') + url.search });
        return void res.end();
      }
      return await page(req, res, parts);
    } catch (e) {
      if (e instanceof HttpError) {
        if (parts[0] === 'api') return json(res, e.status, { error: e.message, code: e.code });
        return send(res, e.status, e.message, 'text/plain; charset=utf-8');
      }
      console.error(`[${nowIso()}] ${method} ${url.pathname}`, e);
      if (!res.headersSent) json(res, 500, { error: 'Erreur interne, réessayez dans un instant' });
      else res.end();
    }
  };
}

export function startServer(opts: Partial<AppOptions> & { port?: number; host?: string } = {}): Server {
  const db = opts.db ?? openDatabase();
  const appUrl = (opts.appUrl ?? process.env.APP_URL ?? `http://localhost:${opts.port ?? process.env.PORT ?? 3000}`).replace(/\/+$/, '');
  const live = opts.live ?? process.env.LIVE_SOURCES !== '0';
  const handler = createApp({ ...opts, db, appUrl, live });
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 90_000;
  purgeExpiredSessions(db);
  if (live) scheduleAudits(db);
  const timer = setInterval(() => {
    purgeExpiredSessions(db);
    if (live) scheduleAudits(db);
  }, 3_600_000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.listen(opts.port ?? Number(process.env.PORT ?? 3000), opts.host ?? process.env.HOST ?? '127.0.0.1');
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = startServer();
  server.on('listening', () => {
    const a = server.address();
    const port = typeof a === 'object' && a ? a.port : '';
    console.log(`Sitolead prêt sur http://${process.env.HOST ?? '127.0.0.1'}:${port}`);
    if (!stripeConfigured()) console.log('Stripe non configuré : les boutons d’abonnement afficheront un message (voir .env.example).');
  });
}
