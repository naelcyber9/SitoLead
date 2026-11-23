// Pré-remplit la base avec de vraies données (OpenStreetMap + SIRENE) pour que les
// pages SEO affichent des chiffres dès le lancement, puis audite les sites trouvés.
//
//   node src/cli/seed.ts annecy plombier coiffeur     une ville, quelques métiers
//   node src/cli/seed.ts annecy                        une ville, tous les métiers
//   node src/cli/seed.ts --all                         toutes les villes SEO × tous les métiers (long)

import { CITIES, TRADES, cityBySlug, tradeBySlug } from '../catalog.ts';
import { openDatabase } from '../db.ts';
import { refreshSearch, scheduleAudits } from '../prospects.ts';
import type { Commune } from '../sources.ts';

const args = process.argv.slice(2);
if (!args.length) {
  console.log('Usage : node src/cli/seed.ts <ville> [métier…] | --all');
  console.log(`Villes : ${CITIES.map((c) => c.slug).join(', ')}`);
  console.log(`Métiers : ${TRADES.map((t) => t.slug).join(', ')}`);
  process.exit(1);
}

const cities = args[0] === '--all' ? CITIES : [cityBySlug(args[0]!)];
if (cities.some((c) => !c)) {
  console.error(`Ville inconnue : ${args[0]}`);
  process.exit(1);
}
const unknown = args.slice(1).filter((s) => !tradeBySlug(s));
if (unknown.length) {
  console.error(`Métier(s) inconnu(s) : ${unknown.join(', ')}`);
  process.exit(1);
}
const trades = args.length > 1 ? args.slice(1).map((s) => tradeBySlug(s)!) : TRADES;

const db = openDatabase();
for (const city of cities) {
  const commune: Commune = { code: city!.code, nom: city!.name, departement: city!.dep, population: 0, codesPostaux: [] };
  for (const trade of trades) {
    const started = Date.now();
    try {
      const r = await refreshSearch(db, commune, trade.slug, { live: true, force: true });
      const warn = r.errors.length ? ` (avertissement : ${r.errors.join(' ; ')})` : '';
      console.log(`${city!.name} · ${trade.plural} : ${r.found} entreprises en ${((Date.now() - started) / 1000).toFixed(1)} s${warn}`);
    } catch (e) {
      console.error(`${city!.name} · ${trade.plural} : échec, ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // politesse envers les API publiques
  }
}

// Audits des sites trouvés : on attend que la file se vide.
const pending = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE site_status = 'pending'`).get() as { n: number }).n);
let left = pending();
if (left) console.log(`Audit de ${left} sites…`);
scheduleAudits(db);
const deadline = Date.now() + 20 * 60_000;
while (left > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  const now = pending();
  if (now !== left) console.log(`  reste ${now}`);
  left = now;
  scheduleAudits(db);
}
const t = db.prepare(`SELECT COUNT(*) AS n, SUM(site_status IN ('none','social','down','unknown')) AS nosite, SUM(site_status = 'weak') AS weak FROM prospects`).get() as {
  n: number;
  nosite: number | null;
  weak: number | null;
};
console.log(`Base : ${t.n} entreprises, ${t.nosite ?? 0} sans vrai site, ${t.weak ?? 0} avec un site à refaire.`);
db.close();
