// Score d'opportunité (0-100) : probabilité qu'un prospect ait besoin d'un site
// et puisse être contacté facilement.

import type { AuditIssue, SiteStatus } from './audit.ts';
import { tradeBySlug } from './catalog.ts';

export interface ProspectLike {
  name: string;
  trade: string;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  created_on: string | null;
  site_status: SiteStatus;
  audit_score: number | null;
  audit_issues: AuditIssue[];
}

export function monthsSince(date: string | null, now = new Date()): number | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
}

export interface ScoreFactor {
  label: string;
  points: number;
}

type ScoreInput = Pick<ProspectLike, 'site_status' | 'audit_score' | 'phone' | 'email' | 'created_on'> & { updated_at?: string | null };

/**
 * Score d'opportunité expliqué : chaque point vient d'une donnée réellement disponible
 * (état du site, contacts, date de création, fraîcheur), jamais d'une estimation inventée.
 */
export function opportunityDetails(p: ScoreInput, now = new Date()): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number) => factors.push({ label, points });
  switch (p.site_status) {
    case 'verified_none': add('Aucun site trouvé après vérification', 90); break;
    case 'down': add('Site renseigné mais inaccessible', 85); break;
    case 'social': add('Seulement une page réseau social ou annuaire', 82); break;
    case 'none': add('Aucun site renseigné dans la source (à vérifier)', 75); break;
    case 'unknown': add('Présence en ligne non vérifiée', 55); break;
    case 'pending': add('Vérification du site en cours', 50); break;
    case 'weak': add(`Site potentiellement obsolète (audit ${p.audit_score ?? '?'}/100)`, Math.round(55 + ((69 - (p.audit_score ?? 69)) * 30) / 69)); break;
    default: add(`Site existant et correct (audit ${p.audit_score ?? '?'}/100)`, Math.round(Math.max(5, 50 - ((p.audit_score ?? 70) - 70) * 1.5)));
  }
  if (p.phone) add('Téléphone professionnel disponible', 6);
  if (p.email) add('Email professionnel disponible', 3);
  // Un prospect sans aucun moyen de contact demande une recherche en plus : il passe après.
  if (!p.phone && !p.email) add('Aucune coordonnée disponible', -8);
  const age = monthsSince(p.created_on, now);
  if (age !== null && age <= 18) add(`Entreprise créée il y a ${Math.max(0, age)} mois`, 8);
  const stale = monthsSince(p.updated_at ?? null, now);
  if (stale !== null && stale >= 12) add('Données de plus d’un an', -5);
  const total = factors.reduce((s, f) => s + f.points, 0);
  return { score: Math.max(0, Math.min(100, total)), factors };
}

export const opportunityScore = (p: ScoreInput, now = new Date()): number => opportunityDetails(p, now).score;

export function statusLabel(status: SiteStatus): string {
  return {
    none: 'Site non renseigné',
    verified_none: 'Aucun site trouvé après vérification',
    social: 'Seulement réseau social ou annuaire',
    down: 'Site inaccessible',
    weak: 'Site potentiellement obsolète',
    ok: 'Site existant',
    unknown: 'Non vérifié',
    pending: 'Vérification en cours',
  }[status];
}

/** Statuts considérés comme « sans vrai site » pour les filtres et les statistiques. */
export const NO_SITE_STATUSES: SiteStatus[] = ['none', 'verified_none', 'social', 'down', 'unknown'];

// --- Messages de prospection -------------------------------------------------

export interface Sender {
  full_name: string | null;
  agency_name: string | null;
  phone: string | null;
  website: string | null;
  email: string;
}

export interface Pitch {
  subject: string;
  email: string;
  call: string;
  sms: string;
}

export function buildPitch(p: ProspectLike, sender: Sender, now = new Date()): Pitch {
  const trade = tradeBySlug(p.trade);
  const benefit = trade?.benefit ?? 'être trouvé par de nouveaux clients sur Google';
  const where = p.city ? ` à ${titleCase(p.city)}` : '';
  const who = sender.full_name || sender.agency_name || 'votre interlocuteur';
  const sig = [sender.full_name, sender.agency_name, sender.phone, sender.website || sender.email].filter(Boolean).join('\n');
  const tradeLabel = (trade?.label ?? 'professionnel').toLowerCase();
  const recent = (monthsSince(p.created_on, now) ?? 99) <= 18;
  const top = p.audit_issues.filter((i) => i.weight > 0).slice(0, 3).map((i) => `• ${i.label}`);

  let hook: string;
  let subject: string;
  switch (p.site_status) {
    case 'verified_none':
      subject = `${p.name} : vos futurs clients vous cherchent sur Google`;
      hook = recent
        ? `Félicitations pour le lancement de ${p.name}${where}. En cherchant « ${tradeLabel}${where} » sur Google, je n’ai pas trouvé de site à votre nom : les clients qui vous cherchent risquent donc de tomber sur vos concurrents.`
        : `En cherchant « ${tradeLabel}${where} » sur Google, je n’ai pas trouvé de site pour ${p.name} : les clients qui vous cherchent risquent donc de tomber sur vos concurrents.`;
      break;
    case 'none':
    case 'unknown':
      // Absence non vérifiée : formulation prudente, on n'affirme pas qu'il n'y a pas de site.
      subject = `${p.name} : votre présence sur internet`;
      hook = recent
        ? `Félicitations pour le lancement de ${p.name}${where}. Sauf erreur de ma part, vous n’avez pas encore de site internet, alors que vos futurs clients cherchent « ${tradeLabel}${where} » sur Google.`
        : `Sauf erreur de ma part, ${p.name} n’a pas de site internet, alors que vos clients cherchent « ${tradeLabel}${where} » sur Google.`;
      break;
    case 'social':
      subject = `${p.name} : passer de Facebook à un vrai site`;
      hook = `J’ai vu que ${p.name} est présent sur les réseaux sociaux, mais sans site à vous. Google met très peu en avant une page Facebook, et vous ne maîtrisez ni la présentation, ni les contacts.`;
      break;
    case 'down':
      subject = `${p.name} : votre site ne s’affiche plus`;
      hook = `En voulant consulter votre site (${p.website}), je suis tombé sur une page qui ne répond plus. Chaque jour, des clients qui vous cherchent repartent donc chez un concurrent.`;
      break;
    default:
      subject = `${p.name} : ${p.audit_issues.length} points qui vous font perdre des clients`;
      hook = `J’ai fait un rapide audit gratuit de votre site (${p.website}). Il vous fait perdre des clients à cause de quelques points précis :\n${top.join('\n')}`;
  }

  const email = [
    'Bonjour,',
    '',
    hook,
    '',
    `Je crée des sites pour les ${trade?.plural ?? 'professionnels'}${where} : un site rapide, lisible sur téléphone et bien placé sur Google, pour ${benefit}.`,
    '',
    'Je peux vous montrer en 15 minutes, sans engagement, à quoi ressemblerait le vôtre. Seriez-vous disponible cette semaine ?',
    '',
    'Bien cordialement,',
    sig,
    '',
    '—',
    'Vous ne souhaitez plus être contacté ? Répondez « STOP » et je ne vous écrirai plus.',
  ].join('\n');

  const call = [
    `Bonjour, je suis ${who}. Je vous appelle au sujet de la présence en ligne de ${p.name}. Vous avez deux minutes ?`,
    '',
    p.site_status === 'weak' || p.site_status === 'down'
      ? `Je suis tombé sur votre site, et j’ai relevé ${Math.max(1, top.length)} problèmes qui font fuir les clients, par exemple : ${p.audit_issues[0]?.label.toLowerCase() ?? 'il ne s’affiche pas bien'}.`
      : `Sauf erreur de ma part, vous n’avez pas de site internet : quand on cherche « ${tradeLabel}${where} » sur Google, ce sont surtout vos concurrents qui apparaissent.`,
    '',
    `Mon métier, c’est justement d’aider les ${trade?.plural ?? 'professionnels'} à ${benefit}.`,
    'Est-ce que je peux vous montrer une maquette de votre futur site, sans engagement ? Quel moment vous arrange ?',
    '',
    'Objection « J’ai déjà assez de clients » : très bien ! Le site sert alors à mieux les choisir et à augmenter vos prix.',
    'Objection « C’est trop cher » : un seul client gagné grâce au site le rembourse en général.',
  ].join('\n');

  const sms = `Bonjour, ${who}${sender.agency_name && sender.full_name ? ` (${sender.agency_name})` : ''}. ${
    p.site_status === 'weak' || p.site_status === 'down' ? `J’ai repéré des problèmes sur le site de ${p.name}` : `Sauf erreur, ${p.name} n’a pas encore de site internet`
  } : je vous propose une maquette gratuite. Intéressé(e) ? STOP pour ne plus être contacté.`;

  return { subject, email, call, sms };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
