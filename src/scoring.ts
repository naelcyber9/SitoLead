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

export function opportunityScore(p: Pick<ProspectLike, 'site_status' | 'audit_score' | 'phone' | 'email' | 'created_on'>, now = new Date()): number {
  let s: number;
  switch (p.site_status) {
    case 'none': s = 90; break;
    case 'social': s = 86; break;
    case 'down': s = 88; break;
    case 'unknown': s = 60; break;
    case 'pending': s = 50; break;
    case 'weak': s = Math.round(55 + ((69 - (p.audit_score ?? 69)) * 30) / 69); break;
    default: s = Math.round(Math.max(5, 50 - ((p.audit_score ?? 70) - 70) * 1.5));
  }
  if (p.phone) s += 4;
  if (p.email) s += 2;
  // Un prospect sans aucun moyen de contact demande une recherche en plus : il passe après.
  if (!p.phone && !p.email) s -= 6;
  const age = monthsSince(p.created_on, now);
  if (age !== null && age <= 18) s += 8;
  return Math.max(0, Math.min(100, s));
}

export function statusLabel(status: SiteStatus): string {
  return {
    none: 'Aucun site',
    social: 'Seulement une page réseau social',
    down: 'Site hors service',
    weak: 'Site à refaire',
    ok: 'Site correct',
    unknown: 'Aucun site référencé',
    pending: 'Audit en cours',
  }[status];
}

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
    case 'none':
    case 'unknown':
      subject = `${p.name} : vos futurs clients vous cherchent sur Google`;
      hook = recent
        ? `Félicitations pour le lancement de ${p.name}${where}. En cherchant « ${tradeLabel}${where} » sur Google, je n’ai trouvé aucun site à votre nom : les clients qui vous cherchent tombent donc sur vos concurrents.`
        : `En cherchant « ${tradeLabel}${where} » sur Google, je n’ai trouvé aucun site pour ${p.name} : les clients qui vous cherchent tombent donc sur vos concurrents.`;
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
      : `En cherchant « ${tradeLabel}${where} » sur Google, je ne vous ai pas trouvé : ce sont vos concurrents qui récupèrent ces appels.`,
    '',
    `Mon métier, c’est justement d’aider les ${trade?.plural ?? 'professionnels'} à ${benefit}.`,
    'Est-ce que je peux vous montrer une maquette de votre futur site, sans engagement ? Quel moment vous arrange ?',
    '',
    'Objection « J’ai déjà assez de clients » : très bien ! Le site sert alors à mieux les choisir et à augmenter vos prix.',
    'Objection « C’est trop cher » : un seul client gagné grâce au site le rembourse en général.',
  ].join('\n');

  const sms = `Bonjour, ${who}${sender.agency_name && sender.full_name ? ` (${sender.agency_name})` : ''}. ${
    p.site_status === 'weak' || p.site_status === 'down' ? `J’ai repéré des problèmes sur le site de ${p.name}` : `${p.name} n’apparaît pas sur Google`
  } : je vous propose une maquette gratuite. Intéressé(e) ? STOP pour ne plus être contacté.`;

  return { subject, email, call, sms };
}

export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}
