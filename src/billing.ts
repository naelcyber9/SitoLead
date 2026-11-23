// Offres, quotas et intégration Stripe (Checkout, portail client, webhooks)
// sans SDK : appels REST + vérification de signature HMAC.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { nowIso, type DB } from './db.ts';

export type PlanId = 'free' | 'pro' | 'agence';

export interface Plan {
  id: PlanId;
  name: string;
  priceEur: number;
  /** Entreprises débloquables : à vie pour l'offre gratuite, par mois sinon. */
  unlocks: number;
  monthly: boolean;
  csv: boolean;
  features: string[];
}

export const FREE_UNLOCKS = 5;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Découverte',
    priceEur: 0,
    unlocks: FREE_UNLOCKS,
    monthly: false,
    csv: false,
    features: [`${FREE_UNLOCKS} entreprises offertes avec coordonnées`, 'Audit complet de leur site', 'Messages de prospection prêts à envoyer', 'Suivi des prospects'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceEur: 29,
    unlocks: 150,
    monthly: true,
    csv: true,
    features: ['150 entreprises par mois', 'Toutes les villes et tous les métiers', 'Audit de site + score d’opportunité', 'Email, appel et SMS personnalisés', 'Pipeline de suivi + relances', 'Export CSV'],
  },
  agence: {
    id: 'agence',
    name: 'Agence',
    priceEur: 79,
    unlocks: 1000,
    monthly: true,
    csv: true,
    features: ['1 000 entreprises par mois', 'Tout ce qui est inclus dans Pro', 'Idéal pour une équipe commerciale', 'Support prioritaire'],
  },
};

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
}

const ACTIVE = new Set(['active', 'trialing', 'past_due']);

export function effectivePlan(u: Pick<UserRow, 'plan' | 'plan_status'>): Plan {
  if (u.plan !== 'free' && PLANS[u.plan] && ACTIVE.has(u.plan_status ?? '')) return PLANS[u.plan];
  return PLANS.free;
}

export interface Quota {
  plan: PlanId;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string | null;
}

export function quotaFor(db: DB, u: UserRow, now = new Date()): Quota {
  const plan = effectivePlan(u);
  let since = '0000';
  let resetsAt: string | null = null;
  if (plan.monthly) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    since = start.toISOString();
    resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  }
  const used = Number((db.prepare('SELECT COUNT(*) AS n FROM leads WHERE user_id = ? AND unlocked_at >= ?').get(u.id, since) as { n: number }).n);
  return { plan: plan.id, limit: plan.unlocks, used, remaining: Math.max(0, plan.unlocks - used), resetsAt };
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

export async function createCheckout(u: UserRow, planId: 'pro' | 'agence', appUrl: string): Promise<string> {
  const plan = PLANS[planId];
  const priceId = planId === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_AGENCE;
  const params: Record<string, string> = {
    mode: 'subscription',
    client_reference_id: String(u.id),
    success_url: `${appUrl}/app?paiement=ok#abonnement`,
    cancel_url: `${appUrl}/app?paiement=annule#abonnement`,
    allow_promotion_codes: 'true',
    billing_address_collection: 'required',
    'tax_id_collection[enabled]': 'true',
    locale: 'fr',
    'line_items[0][quantity]': '1',
    'metadata[user_id]': String(u.id),
    'metadata[plan]': planId,
    'subscription_data[metadata][user_id]': String(u.id),
    'subscription_data[metadata][plan]': planId,
  };
  if (priceId) params['line_items[0][price]'] = priceId;
  else {
    params['line_items[0][price_data][currency]'] = 'eur';
    params['line_items[0][price_data][unit_amount]'] = String(plan.priceEur * 100);
    params['line_items[0][price_data][recurring][interval]'] = 'month';
    params['line_items[0][price_data][product_data][name]'] = `Sitolead ${plan.name}`;
  }
  if (u.stripe_customer_id) {
    params.customer = u.stripe_customer_id;
    params['customer_update[address]'] = 'auto';
    params['customer_update[name]'] = 'auto';
  } else params.customer_email = u.email;
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

const isPlan = (p: unknown): p is 'pro' | 'agence' => p === 'pro' || p === 'agence';

/** Applique un événement Stripe. Idempotent : un même événement n'est traité qu'une fois. */
export function handleStripeEvent(db: DB, ev: StripeEvent): 'ok' | 'duplicate' | 'ignored' {
  const seen = db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(ev.id, nowIso());
  if (seen.changes === 0) return 'duplicate';
  const o = ev.data.object;
  switch (ev.type) {
    case 'checkout.session.completed': {
      const userId = Number(o.client_reference_id ?? o.metadata?.user_id);
      const plan = o.metadata?.plan;
      if (!userId || !isPlan(plan)) return 'ignored';
      db.prepare(
        `UPDATE users SET plan = ?, plan_status = 'active', stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = ?`,
      ).run(plan, o.customer ?? null, o.subscription ?? null, userId);
      return 'ok';
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const userId = Number(o.metadata?.user_id) || userIdByCustomer(db, o.customer);
      if (!userId) return 'ignored';
      const plan = isPlan(o.metadata?.plan) ? o.metadata.plan : null;
      const end = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
      const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : String(o.status);
      db.prepare(
        `UPDATE users SET plan = CASE WHEN ? = 'canceled' THEN 'free' ELSE COALESCE(?, plan) END, plan_status = ?,
         stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = ?, period_end = ? WHERE id = ?`,
      ).run(status, plan, status, o.customer ?? null, o.id ?? null, end ? new Date(end * 1000).toISOString() : null, userId);
      return 'ok';
    }
    case 'invoice.payment_failed': {
      const userId = userIdByCustomer(db, o.customer);
      if (!userId) return 'ignored';
      db.prepare(`UPDATE users SET plan_status = 'past_due' WHERE id = ? AND plan != 'free'`).run(userId);
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
