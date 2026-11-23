// Démo hors ligne du moteur Sitolead : audit d'un site, score d'opportunité
// et message de prospection personnalisé, sur 3 entreprises types.
// Lancer :  node src/cli/demo.ts        (ajouter --live pour une vraie recherche OSM)

import { analyzeSite, classifyWebsite } from '../audit.ts';
import { opportunityScore, statusLabel, buildPitch, type ProspectLike } from '../scoring.ts';

const now = new Date();
const sender = { full_name: 'Naël B.', agency_name: 'Studio Web Var', phone: '06 00 00 00 00', website: null, email: 'nael@exemple.fr' };

const vieuxSite = analyzeSite({
  requestedUrl: 'http://plomberie-durand.fr',
  finalUrl: 'http://plomberie-durand.fr/',
  status: 200,
  ms: 4200,
  html: '<html><head><title>Accueil</title></head><body><p>Plomberie Durand © 2016</p></body></html>',
});

const cas: (ProspectLike & { label: string })[] = [
  { label: 'Sans site', name: 'Boulangerie Le Fournil', trade: 'boulangerie', city: 'LA SEYNE-SUR-MER', phone: '04 94 00 00 01', email: null, website: null,
    created_on: new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString(), site_status: 'none', audit_score: null, audit_issues: [] },
  { label: 'Page Facebook seule', name: 'Salon Coiff’Elle', trade: 'coiffeur', city: 'Toulon', phone: '04 94 00 00 02', email: 'contact@coiffelle.fr',
    website: 'facebook.com/coiffelle', created_on: '2019-03-01', site_status: classifyWebsite('facebook.com/coiffelle') === 'social' ? 'social' : 'none', audit_score: null, audit_issues: [] },
  { label: 'Site faible', name: 'Plomberie Durand', trade: 'plombier', city: 'Hyères', phone: '06 00 00 00 03', email: null,
    website: 'plomberie-durand.fr', created_on: '2010-05-01', site_status: vieuxSite.status, audit_score: vieuxSite.score, audit_issues: vieuxSite.issues },
];

for (const p of cas) {
  const score = opportunityScore(p, now);
  const pitch = buildPitch(p, sender, now);
  console.log('\n' + '='.repeat(70));
  console.log(`${p.label.toUpperCase()} — ${p.name} (${p.city})`);
  console.log(`Statut : ${statusLabel(p.site_status)}${p.audit_score !== null ? ` | score du site : ${p.audit_score}/100` : ''}`);
  console.log(`Score d’opportunité : ${score}/100`);
  if (p.audit_issues.length) console.log('Problèmes détectés :\n' + p.audit_issues.map((i) => `  - ${i.label} (-${i.weight})`).join('\n'));
  console.log(`\nObjet : ${pitch.subject}\n\n${pitch.email}\n\nSMS : ${pitch.sms}`);
}

if (process.argv.includes('--live')) {
  const { fetchOsm, communeByCode } = await import('../sources.ts');
  const { tradeBySlug } = await import('../catalog.ts');
  const commune = await communeByCode('83126'); // La Seyne-sur-Mer
  const trade = tradeBySlug('boulangerie')!;
  if (commune) {
    const found = await fetchOsm(commune, trade);
    const sans = found.filter((f) => classifyWebsite(f.website) !== 'site');
    console.log(`\nLIVE OpenStreetMap — ${trade.plural} à ${commune.nom} : ${found.length} trouvées, ${sans.length} sans vrai site.`);
    for (const f of sans.slice(0, 10)) console.log(`  - ${f.name} | ${f.phone ?? 'tél. ?'} | ${f.website ?? 'aucun site'}`);
  }
}
