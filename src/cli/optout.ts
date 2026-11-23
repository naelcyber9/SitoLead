// Traite une demande de suppression ou d'opposition d'une entreprise (RGPD).
// La fiche est supprimée et ne sera plus jamais réimportée.
//
//   node src/cli/optout.ts 12345678900011         SIRET (un établissement)
//   node src/cli/optout.ts 123456789              SIREN (toute l'entreprise)
//   node src/cli/optout.ts contact@exemple.fr     email
//   node src/cli/optout.ts "04 50 00 00 00"       téléphone
//   node src/cli/optout.ts osm:node/123456        fiche précise
//   node src/cli/optout.ts --list                 demandes enregistrées à la main

import { openDatabase } from '../db.ts';
import { addOptOuts, optOutKey } from '../prospects.ts';

const args = process.argv.slice(2);
if (!args.length) {
  console.log('Usage : node src/cli/optout.ts <SIRET | SIREN | email | téléphone | osm:…> [motif]  |  --list');
  process.exit(1);
}

const db = openDatabase();
if (args[0] === '--list') {
  const rows = db.prepare(`SELECT key, reason, created_at FROM optouts WHERE reason NOT LIKE 'Opposition à la prospection commerciale%' ORDER BY created_at DESC`).all() as {
    key: string;
    reason: string;
    created_at: string;
  }[];
  const auto = Number((db.prepare('SELECT COUNT(*) AS n FROM optouts').get() as { n: number }).n) - rows.length;
  for (const r of rows) console.log(`${r.created_at.slice(0, 10)}  ${r.key}  (${r.reason})`);
  console.log(`${rows.length} demande(s) manuelle(s), ${auto} opposition(s) issues du registre SIRENE.`);
} else {
  const key = optOutKey(args[0]!);
  if (!key) {
    console.error(`Format non reconnu : ${args[0]}`);
    process.exit(1);
  }
  const reason = args.slice(1).join(' ') || 'Demande de suppression reçue';
  const removed = addOptOuts(db, [key], reason);
  console.log(`Opposition enregistrée (${key}). ${removed} fiche(s) supprimée(s).`);
}
db.close();
