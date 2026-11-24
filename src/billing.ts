// Offres, quotas et intégration Stripe (Checkout, portail client, webhooks)
// sans SDK : appels REST + vérification de signature HMAC.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { nowIso, type DB } from './db.ts';

export type PlanId = 'free' | 'starter' | 'pro' | 'agence';
export type PaidPlanId = Exclude<PlanId, 'free'>;
export type Interval = 'month' | 'year';

export interface Plan {
  id: PlanId;
  name: string;
  /** Prix mensuel HT ; l'annuel vaut 10 mois (2 mois offerts). */
  priceEur: number;
  yearlyEur: number;
  /** Entreprises débloquables : à vie pour l'offre gratuite, par mois sinon. */
  unlocks: number;
  monthly: boolean;
  csv: boolean;
  /**
   * Recherches distinctes (zone × métier) par jour. Une recherche coûte des appels aux sources
   * même sans déblocage : elle est donc plafonnée, y compris sur les offres payantes.
   */
  searchesPerDay: number;
  /** Maquettes créées : au total pour l'offre gratuite, par mois sinon. */
  mockups: number;
  /** Rédactions de textes par IA par mois. */
  aiPerMonth: number;
  /** Images conservées (logos, photos des maquettes). */
  mediaMax: number;
  features: string[];
}

export const FREE_UNLOCKS = 5;

// Grille validée par le calcul de coûts (docs/COUTS.md) : aucune offre illimitée, chaque
// quota borne un coût variable (IA, stockage, appels aux sources).
export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Découverte', priceEur: 0, yearlyEur: 0,
    unlocks: FREE_UNLOCKS, monthly: false, csv: false, searchesPerDay: 20, mockups: 1, aiPerMonth: 3, mediaMax: 6,
    features: [`${FREE_UNLOCKS} entreprises offertes avec coordonnées`, '1 maquette de site offerte', 'Audit de leur site et score expliqué', 'Messages de prospection prêts à envoyer', 'Suivi commercial'],
  },
  starter: {
    id: 'starter', name: 'Starter', priceEur: 19, yearlyEur: 190,
    unlocks: 50, monthly: true, csv: true, searchesPerDay: 100, mockups: 10, aiPerMonth: 30, mediaMax: 60,
    features: ['50 entreprises par mois', '10 maquettes de site par mois', '30 rédactions IA par mois', 'Recherche par ville, département, région, rayon', 'Suivi commercial et rappels', 'Export CSV'],
  },
  pro: {
    id: 'pro', name: 'Pro', priceEur: 49, yearlyEur: 490,
    unlocks: 200, monthly: true, csv: true, searchesPerDay: 300, mockups: 50, aiPerMonth: 100, mediaMax: 400,
    features: ['200 entreprises par mois', '50 maquettes de site par mois', '100 rédactions IA par mois', 'Logo et photos dans les maquettes', 'Tout ce qui est inclus dans Starter'],
  },
  agence: {
    id: 'agence', name: 'Agence', priceEur: 99, yearlyEur: 990,
    unlocks: 500, monthly: true, csv: true, searchesPerDay: 800, mockups: 150, aiPerMonth: 300, mediaMax: 1500,
    features: ['500 entreprises par mois', '150 maquettes de site par mois', '300 rédactions IA par mois', 'Tout ce qui est inclus dans Pro', 'Support prioritaire'],
  },
};

export const isPaidPlan = (p: unknown): p is PaidPlanId => p === 'starter' || p === 'pro' || p === 'agence';

/** Packs de crédits : entreprises supplémentaires sans abonnement, valables sans limite de durée. */
export const PACKS = {
  leads50: { id: 'leads50', unlocks: 50, priceEur: 19, name: '50 entreprises supplémentaires' },
  leads150: { id: 'leads150', unlocks: 150, priceEur: 45, name: '150 entreprises supplémentaires' },
} as const;
export type PackId = keyof typeof PACKS;
export const isPack = (p: unknown): p is PackId => typeof p === 'string' && p in PACKS;

/** Délai pendant lequel un abonnement dont le paiement a échoué reste actif. */
export const GRACE_DAYS = 7;

export interface UserRow {
  id: number;
  email: string;
  plan: PlanId;
  plan_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  period_end: string | null;
  full_name: string | null;
  agency_name: string | null;
  phone: string | null;
  website: string | null;
  created_at: string;
  /** Premier échec de paiement non régularisé (délai de grâce). */
  payment_failed_at?: string | null;
  billing_interval?: string | null;
  /** 'admin' pour l'administrateur. */
  role?: string | null;
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

/** Fin du délai de grâce d'un paiement échoué, ou null si aucun impayé. */
export function graceEndsAt(u: Pick<UserRow, 'plan_status' | 'payment_failed_at'>): string | null {
  if (u.plan_status !== 'past_due' || !u.payment_failed_at) return null;
  return new Date(Date.parse(u.payment_failed_at) + GRACE_DAYS * 86_400_000).toISOString();
}

export function effectivePlan(u: Pick<UserRow, 'plan' | 'plan_status'> & { payment_failed_at?: string | null }, now = new Date()): Plan {
  if (u.plan === 'free' || !PLANS[u.plan] || !ACTIVE.has(u.plan_status ?? '')) return PLANS.free;
  // Paiement échoué : l'accès est maintenu pendant le délai de grâce, puis suspendu.
  const grace = graceEndsAt({ plan_status: u.plan_status, payment_failed_at: u.payment_failed_at ?? null });
  if (grace && Date.parse(grace) < now.getTime()) return PLANS.free;
  return PLANS[u.plan];
}

export interface Quota {
  plan: PlanId;
  limit: number;
  used: number;
  /** Déblocages restants : offre + crédits achetés. */
  remaining: number;
  /** Crédits achetés encore disponibles (inclus dans remaining). */
  credits: number;
  resetsAt: string | null;
}

/** Crédits achetés (packs) moins ceux déjà utilisés. */
export function creditBalance(db: DB, userId: number): number {
  const bought = Number((db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM credits WHERE user_id = ?').get(userId) as { n: number }).n);
  const spent = Number((db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND credit_used = 1').get(userId) as { n: number }).n);
  return Math.max(0, bought - spent);
}

export function quotaFor(db: DB, u: UserRow, now = new Date()): Quota {
  const plan = effectivePlan(u, now);
  let since = '0000';
  let resetsAt: string | null = null;
  if (plan.monthly) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    since = start.toISOString();
    resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  // Les déblocages payés avec des crédits ne consomment pas le quota de l'offre.
  const used = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND unlocked_at >= ? AND COALESCE(credit_used, 0) = 0').get(u.id, since) as { n: number }).n,
  );
  const credits = creditBalance(db, u.id);
  return { plan: plan.id, limit: plan.unlocks, used, remaining: Math.max(0, plan.unlocks - used) + credits, credits, resetsAt };
}

/** Le prochain déblocage est-il payé par l'offre (false) ou par un crédit acheté (true) ? */
export function nextUnlockUsesCredit(db: DB, u: UserRow, now = new Date()): boolean {
  const q = quotaFor(db, u, now);
  return q.remaining - q.credits <= 0 && q.credits > 0;
}

/**
 * Compte une recherche distincte du jour et dit si elle est autorisée. Relancer la même
 * recherche (pagination, rafraîchissement automatique) ne consomme rien.
 */
export function useSearch(db: DB, u: UserRow, key: string, now = new Date()): { allowed: boolean; used: number; limit: number } {
  const limit = effectivePlan(u).searchesPerDay;
  const day = now.toISOString().slice(0, 10);
  const count = () => Number((db.prepare('SELECT COUNT(*) AS n FROM search_usage WHERE user_id = ? AND day = ?').get(u.id, day) as { n: number }).n);
  if (db.prepare('SELECT 1 FROM search_usage WHERE user_id = ? AND day = ? AND key = ?').get(u.id, day, key)) {
    return { allowed: true, used: count(), limit };
  }
  const used = count();
  if (used >= limit) return { allowed: false, used, limit };
  db.prepare('INSERT INTO search_usage (user_id, day, key) VALUES (?, ?, ?)').run(u.id, day, key);
  // Ménage : l'historique au-delà de 60 jours ne sert plus.
  if (Math.random() < 0.01) db.prepare('DELETE FROM search_usage WHERE day < ?').run(new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10));
  return { allowed: true, used: used + 1, limit };
}

// --- Stripe -------------------------------------------------------------------

export const stripeConfigured = () => Boolean(process.env.STRIPE_SECRET_KEY);

async function stripe(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Stripe : ${body.error?.message ?? res.status}`);
  return body;
}

function checkoutBase(u: UserRow, appUrl: string): Record<string, string> {
  const params: Record<string, string> = {
    client_reference_id: String(u.id),
    success_url: `${appUrl}/app?paiement=ok#abonnement`,
    cancel_url: `${appUrl}/app?paiement=annule#abonnement`,
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
    locale: 'fr',
    'line_items[0][quantity]': '1',
    'metadata[user_id]': String(u.id),
  };
  if (u.stripe_customer_id) {
    params.customer = u.stripe_customer_id;
    params['customer_update[address]'] = 'auto';
    params['customer_update[name]'] = 'auto';
  } else params.customer_email = u.email;
  return params;
}

/**
 * Abonnement à une offre, au mois ou à l'année. Identifiants de prix Stripe facultatifs
 * (STRIPE_PRICE_PRO_MONTH, STRIPE_PRICE_PRO_YEAR…) ; sinon le prix est défini dans la session.
 */
export async function createCheckout(u: UserRow, planId: PaidPlanId, appUrl: string, interval: Interval = 'month'): Promise<string> {
  const plan = PLANS[planId];
  const priceId = process.env[`STRIPE_PRICE_${planId.toUpperCase()}_${interval.toUpperCase()}`];
  const params: Record<string, string> = {
    ...checkoutBase(u, appUrl),
    mode: 'subscription',
    allow_promotion_codes: 'true',
    'metadata[plan]': planId,
    'metadata[interval]': interval,
    'subscription_data[metadata][user_id]': String(u.id),
    'subscription_data[metadata][plan]': planId,
    'subscription_data[metadata][interval]': interval,
  };
  if (priceId) params['line_items[0][price]'] = priceId;
  else {
    params['line_items[0][price_data][currency]'] = 'eur';
    params['line_items[0][price_data][unit_amount]'] = String((interval === 'year' ? plan.yearlyEur : plan.priceEur) * 100);
    params['line_items[0][price_data][recurring][interval]'] = interval;
    params['line_items[0][price_data][product_data][name]'] = `SitoLead ${plan.name}${interval === 'year' ? ' (annuel)' : ''}`;
  }
  const session = await stripe('checkout/sessions', params);
  return String(session.url);
}

/** Achat ponctuel d'un pack de crédits (paiement unique, sans abonnement). */
export async function createPackCheckout(u: UserRow, packId: PackId, appUrl: string): Promise<string> {
  const pack = PACKS[packId];
  const params: Record<string, string> = {
    ...checkoutBase(u, appUrl),
    mode: 'payment',
    'metadata[pack]': packId,
    'invoice_creation[enabled]': 'true',
    'line_items[0][price_data][currency]': 'eur',
    'line_items[0][price_data][unit_amount]': String(pack.priceEur * 100),
    'line_items[0][price_data][product_data][name]': `SitoLead : ${pack.name}`,
  };
  const session = await stripe('checkout/sessions', params);
  return String(session.url);
}

export async function createPortal(u: UserRow, appUrl: string): Promise<string> {
  if (!u.stripe_customer_id) throw new Error('Aucun abonnement à gérer');
  const s = await stripe('billing_portal/sessions', { customer: u.stripe_customer_id, return_url: `${appUrl}/app#abonnement` });
  return String(s.url);
}

/** Vérifie l'en-tête Stripe-Signature (t=...,v1=...) : HMAC-SHA256 de `${t}.${payload}`. */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't') t = v ?? '';
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!/^\d+$/.test(t) || Math.abs(nowSec - Number(t)) > toleranceSec || !sigs.length) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex'));
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

/** Applique un événement Stripe. Idempotent : un même événement n'est traité qu'une fois. */
export function handleStripeEvent(db: DB, ev: StripeEvent): 'ok' | 'duplicate' | 'ignored' {
  const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(ev.id, nowIso());
  if (seen.changes === 0) return 'duplicate';
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed': {
      const userId = Number(o.client_reference_id ?? o.metadata?.user_id);
      if (!userId) return 'ignored';
      // Pack de crédits : ajouté une seule fois par session de paiement, et seulement si payé.
      if (isPack(o.metadata?.pack)) {
        if (o.payment_status && o.payment_status !== 'paid') return 'ignored';
        const pack = PACKS[o.metadata.pack as PackId];
        db.prepare('INSERT OR IGNORE INTO credits (user_id, amount, source, created_at) VALUES (?, ?, ?, ?)').run(userId, pack.unlocks, `stripe:${o.id}`, nowIso());
        if (o.customer) db.prepare('UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?').run(o.customer, userId);
        return 'ok';
      }
      const plan = o.metadata?.plan;
      if (!isPaidPlan(plan)) return 'ignored';
      db.prepare(
        `UPDATE users SET plan = ?, plan_status = 'active', payment_failed_at = NULL, billing_interval = ?,
         stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?`,
      ).run(plan, o.metadata?.interval === 'year' ? 'year' : 'month', o.customer ?? null, o.subscription ?? null, userId);
      return 'ok';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = Number(o.metadata?.user_id) || userIdByCustomer(db, o.customer);
      if (!userId) return 'ignored';
      const plan = isPaidPlan(o.metadata?.plan) ? o.metadata.plan : null;
      const end = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
      const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : String(o.status);
      // Régularisé (actif) : le délai de grâce est levé. Toujours impayé : la date du premier échec est conservée.
      db.prepare(
        `UPDATE users SET plan = CASE WHEN ? = 'canceled' THEN 'free' ELSE COALESCE(?, plan) END, plan_status = ?,
         payment_failed_at = CASE WHEN ? IN ('active', 'trialing') THEN NULL ELSE payment_failed_at END,
         stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?, period_end = ? WHERE id = ?`,
      ).run(status, plan, status, status, o.customer ?? null, o.id ?? null, end ? new Date(end * 1000).toISOString() : null, userId);
      return 'ok';
    }
    case 'invoice.payment_failed': {
      const userId = userIdByCustomer(db, o.customer);
      if (!userId) return 'ignored';
      db.prepare(
        `UPDATE users SET plan_status = 'past_due', payment_failed_at = COALESCE(payment_failed_at, ?) WHERE id = ? AND plan != 'free'`,
      ).run(nowIso(), userId);
      return 'ok';
    }
    case 'invoice.paid': {
      const userId = userIdByCustomer(db, o.customer);
      if (!userId) return 'ignored';
      db.prepare(`UPDATE users SET plan_status = 'active', payment_failed_at = NULL WHERE id = ? AND plan_status = 'past_due'`).run(userId);
      return 'ok';
    }
    default:
      return 'ignored';
  }
}

function userIdByCustomer(db: DB, customer: unknown): number {
  if (typeof customer !== 'string') return 0;
  const r = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(customer) as { id: number } | undefined;
  return r?.id ?? 0;
}
