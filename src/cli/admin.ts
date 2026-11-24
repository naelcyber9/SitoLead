// Crée le compte administrateur, ou donne le rôle administrateur à un compte existant.
//   npm run admin -- vous@exemple.fr
// Un nouveau compte reçoit un mot de passe provisoire, affiché une seule fois : changez-le
// ensuite depuis l'application (Profil → Changer mon mot de passe).

import { EMAIL_RE } from '../auth.ts';
import { ensureAdmin } from '../admin.ts';
import { openDatabase } from '../db.ts';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!EMAIL_RE.test(email)) {
  console.error('Usage : npm run admin -- vous@exemple.fr');
  process.exit(1);
}
const db = openDatabase();
const r = await ensureAdmin(db, email);
if (r.created) {
  console.log(`Compte administrateur créé : ${email}`);
  console.log(`Mot de passe provisoire (affiché une seule fois) : ${r.password}`);
  console.log('Connectez-vous puis changez-le dans Profil → Changer mon mot de passe.');
} else {
  console.log(`Le compte ${email} existe déjà : il a maintenant le rôle administrateur (mot de passe inchangé).`);
}
db.close();
