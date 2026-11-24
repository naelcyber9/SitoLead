// Rédaction des textes d'une maquette par l'IA (Claude), avec trois garde-fous de coût :
//  1. désactivée tant qu'aucune clé n'est configurée (ANTHROPIC_API_KEY) ;
//  2. quota mensuel de générations par offre ;
//  3. budget quotidien global en dollars (AI_DAILY_BUDGET_USD, 2 $ par défaut) : au-delà,
//     plus aucune génération jusqu'au lendemain, quel que soit l'utilisateur.
// Et un garde-fou de contenu : le modèle ne reçoit que des faits réels, a pour consigne de ne
// rien inventer, et toute phrase contenant une affirmation invérifiable est retirée ensuite.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { effectivePlan, type UserRow } from './billing.ts';
import { nowIso, type DB } from './db.ts';
import type { MockupData } from './mockups.ts';

export const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
/** Tarifs du modèle par défaut (USD par million de jetons) : entrée, sortie. */
const PRICE = { input: 4, output: 20 };

export const aiConfigured = (): boolean => Boolean(process.env.ANTHROPIC_API_KEY?.trim());
const dailyBudgetUsd = () => Number(process.env.AI_DAILY_BUDGET_USD ?? 2) || 0;

/** Générations IA par mois selon l'offre (l'offre gratuite en a quelques-unes pour essayer). */
export const AI_PER_MONTH: Record<string, number> = { free: 3, pro: 100, agence: 300 };

export function aiQuota(db: DB, u: UserRow, now = new Date()): { limit: number; used: number; remaining: number } {
  const plan = effectivePlan(u);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const used = Number((db.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE user_id = ? AND created_at >= ?').get(u.id, since) as { n: number }).n);
  const limit = AI_PER_MONTH[plan.id] ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export function spentTodayUsd(db: DB, now = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  return Number((db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_usage WHERE created_at >= ?').get(day) as { c: number }).c);
}

// --- Garde-fou de contenu ------------------------------------------------------------------

/**
 * Affirmations qu'on ne peut pas faire sans preuve : ancienneté, prix, labels, avis, garanties,
 * classements, disponibilité permanente, délais chiffrés.
 */
const UNVERIFIABLE = [
  /\b\d+\s*(ans|années)\b/i,
  /\bdepuis\s+(19|20)\d{2}\b/i,
  /€|\beuros?\b|\btarifs?\s+(bas|imbattables?|compétitifs?)\b|\bprix\s+(bas|imbattables?|compétitifs?)\b|\bgratuit/i,
  /\bcertifi|\bqualifi[ée]|\blabel|\bRGE\b|\bQualibat\b|\bQualifelec\b|\bagré[ée]|\bdécennale\b/i,
  // (pas de \b devant « é » : en JavaScript, \b ne reconnaît que les lettres ASCII)
  /\bavis\b|(^|[^\p{L}])étoiles?([^\p{L}]|$)|\btémoignage|\bclients? satisfaits?\b|\bnote de\b/iu,
  /\bgaranti/i,
  /\bn°\s*1\b|\bnuméro\s+1\b|\ble meilleur\b|\bla meilleure\b|\bleader\b/i,
  /\b24\s*h?\s*\/\s*24\b|\b7\s*j?\s*\/\s*7\b|\b24h\b|\bjour et nuit\b/i,
  /\ben moins de\s+\d+|\bsous\s+\d+\s*(h|heures?|minutes?)\b|\bintervention en \d+/i,
];

export const isUnverifiable = (s: string): boolean => UNVERIFIABLE.some((re) => re.test(s));

/** Retire les phrases contenant une affirmation invérifiable. */
export function stripClaims(text: string): string {
  return (text.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s && !isUnverifiable(s))
    .join(' ');
}

// --- Génération --------------------------------------------------------------------------------

const Suggestion = z.object({
  tagline: z.string(),
  about: z.string(),
  services: z.array(z.string()),
  cta: z.string(),
});
export type AiSuggestion = z.infer<typeof Suggestion>;

const TONES = { professionnel: 'sobre et professionnel', chaleureux: 'chaleureux et proche', direct: 'direct et concis' } as const;
export type Tone = keyof typeof TONES;
export const isTone = (t: unknown): t is Tone => typeof t === 'string' && t in TONES;

const SYSTEM = `Tu rédiges les textes d'une maquette de site vitrine pour une petite entreprise locale française. Cette maquette sera présentée à l'entreprise comme une proposition commerciale.

Règle absolue : n'écris que ce que les faits fournis permettent d'affirmer. L'entreprise n'a rien validé, donc toute information inventée serait trompeuse. En particulier, n'écris jamais :
- d'ancienneté, de nombre d'années d'expérience ou de date de création ;
- de prix, de tarif, de promotion ni de devis gratuit ;
- de certification, de label, de qualification, d'assurance ou d'agrément ;
- d'avis, de note, de témoignage ni de nombre de clients ;
- de garantie, de classement (« le meilleur », « n°1 ») ni de délai d'intervention chiffré ;
- de disponibilité permanente (24h/24, 7j/7, urgences de nuit).

Les prestations sont des propositions typiques du métier, formulées simplement (2 à 6 mots chacune), que l'utilisateur fera valider par l'entreprise. Écris en français correct, sans majuscules inutiles, sans point d'exclamation ni emoji. Accroche : 90 caractères au plus. Présentation : 2 à 4 phrases, 500 caractères au plus. Bouton : 30 caractères au plus. Entre 3 et 6 prestations.`;

export interface AiInput {
  name: string;
  tradeLabel: string;
  city: string;
  area: string;
  /** Prestations et présentation déjà saisies par l'utilisateur : à reprendre en priorité. */
  services: string[];
  about: string;
  tone: Tone;
}

export type AiResult =
  | { ok: true; suggestion: AiSuggestion; costUsd: number }
  | { ok: false; reason: 'disabled' | 'quota' | 'budget' | 'refused' | 'error'; message: string };

export type Generate = (input: AiInput) => Promise<{ suggestion: AiSuggestion | null; inputTokens: number; outputTokens: number; refused: boolean }>;

/** Appel réel à l'API Claude (remplaçable dans les tests). */
export const callClaude: Generate = async (input) => {
  const client = new Anthropic();
  const facts = [
    `Nom de l'entreprise : ${input.name}`,
    `Métier : ${input.tradeLabel}`,
    `Ville : ${input.city}`,
    input.area ? `Zone d'intervention : ${input.area}` : '',
    input.services.length ? `Prestations envisagées par l'utilisateur : ${input.services.join(' ; ')}` : '',
    input.about ? `Présentation actuelle (à améliorer) : ${input.about}` : '',
    `Ton souhaité : ${TONES[input.tone]}`,
  ].filter(Boolean).join('\n');
  const response = await client.messages.parse({
    model: AI_MODEL,
    max_tokens: 2000,
    // Rédaction courte et cadrée : un effort faible suffit et limite le coût.
    output_config: { effort: 'low', format: zodOutputFormat(Suggestion) },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Faits disponibles :\n${facts}\n\nRédige l'accroche, la présentation, les prestations et le texte du bouton.` }],
  });
  return {
    suggestion: response.stop_reason === 'refusal' ? null : response.parsed_output,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    refused: response.stop_reason === 'refusal',
  };
};

const clip = (s: string, n: number) => s.trim().slice(0, n);

export async function suggestTexts(db: DB, u: UserRow, input: AiInput, generate: Generate = callClaude): Promise<AiResult> {
  if (!aiConfigured()) return { ok: false, reason: 'disabled', message: 'La rédaction par IA n’est pas activée sur ce serveur.' };
  if (aiQuota(db, u).remaining <= 0) {
    return { ok: false, reason: 'quota', message: 'Vous avez utilisé vos rédactions IA du mois. Les textes restent modifiables à la main.' };
  }
  if (spentTodayUsd(db) >= dailyBudgetUsd()) {
    return { ok: false, reason: 'budget', message: 'La rédaction par IA est momentanément indisponible (plafond du jour atteint). Réessayez demain.' };
  }
  let r;
  try {
    r = await generate(input);
  } catch {
    return { ok: false, reason: 'error', message: 'Le service de rédaction ne répond pas, réessayez dans un instant.' };
  }
  const costUsd = (r.inputTokens * PRICE.input + r.outputTokens * PRICE.output) / 1_000_000;
  db.prepare('INSERT INTO ai_usage (user_id, created_at, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?)').run(
    u.id, nowIso(), r.inputTokens, r.outputTokens, costUsd,
  );
  if (r.refused || !r.suggestion) return { ok: false, reason: 'refused', message: 'La rédaction n’a pas abouti pour cette entreprise : écrivez les textes à la main.' };
  const s = r.suggestion;
  const services = s.services.map((x) => clip(x, 80)).filter((x) => x && !isUnverifiable(x)).slice(0, 6);
  return {
    ok: true,
    costUsd,
    suggestion: {
      tagline: isUnverifiable(s.tagline) ? '' : clip(s.tagline, 120),
      about: clip(stripClaims(s.about), 1200),
      services,
      cta: isUnverifiable(s.cta) ? '' : clip(s.cta, 40),
    },
  };
}

/** Applique une suggestion à un contenu de maquette (champs vides de la suggestion ignorés). */
export function applySuggestion(d: MockupData, s: AiSuggestion): MockupData {
  return {
    ...d,
    tagline: s.tagline || d.tagline,
    about: s.about || d.about,
    services: s.services.length ? s.services : d.services,
    cta: s.cta || d.cta,
  };
}
