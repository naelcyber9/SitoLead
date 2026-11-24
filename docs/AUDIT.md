# Audit de SitoLead — 24 novembre 2026

Audit du code existant avant la transformation en SaaS commercialisable. Il recense ce qui
fonctionne, les défauts trouvés et ce qui a été corrigé pendant la phase 1.

## Architecture constatée

| Élément | Choix existant | Avis |
|---|---|---|
| Serveur | Node.js 24+ sans framework (`node:http`), TypeScript exécuté nativement (type stripping) | Sobre, rapide, peu de dépendances : conservé |
| Base | SQLite (`node:sqlite`), fichier `data/sitolead.db`, WAL | Suffisant jusqu'à plusieurs milliers d'utilisateurs sur un serveur ; prévoir PostgreSQL si plusieurs serveurs |
| Front | HTML/CSS/JS sans framework, CSP stricte (`script-src 'self'`) | Conservé ; Leaflet ajouté en fichier local pour respecter la CSP |
| Pages publiques | Rendu serveur (accueil, tarifs, villes, métiers, légal, sitemap) | Bon pour le SEO |
| Paiement | Stripe Checkout + portail + webhooks signés (REST, sans SDK) | Solide, idempotent |
| Sources | OpenStreetMap (Overpass), SIRENE (API Recherche d'entreprises), geo.api.gouv.fr | Sources légales et gratuites ; limites d'usage à respecter (voir plus bas) |
| Tests | `node --test`, 27 tests au départ | Bonne base ; 39 tests après la phase 1 |

## Fonctionnalités existantes qui fonctionnent

- Inscription / connexion (scrypt, sessions opaques hachées, cookie `HttpOnly` + `SameSite=Lax` + `Secure` en HTTPS).
- Annuaire par commune et métier (18 métiers), résultats masqués avant déblocage.
- 5 déblocages gratuits à vie, puis abonnements Pro (29 €) et Agence (79 €) mensuels.
- Audit automatique des sites existants (HTTPS, mobile, vitesse, SEO, ancienneté, formulaire…), protégé contre le SSRF.
- Messages préremplis : email, script d'appel, SMS, avec mention de désinscription.
- Pipeline de suivi (statuts, notes, prochaine action), export CSV (offres payantes).
- Oppositions RGPD : registre SIRENE + demandes de suppression (CLI `optout`), appliquées à l'import.
- Pages SEO par ville et métier, sans aucune coordonnée publiée.

## Défauts trouvés

### Corrigés pendant la phase 1

| # | Défaut | Gravité | Correction |
|---|---|---|---|
| 1 | Paris, Lyon et Marseille ne trouvaient **aucune** entreprise récente dans SIRENE (registre découpé par arrondissement) | Élevée | Interrogation par arrondissement |
| 2 | Une entreprise **sans site renseigné** dans OpenStreetMap était affichée « Aucun site », et le mail affirmait « je n'ai trouvé aucun site » : affirmation non vérifiée | Élevée (crédibilité, fausse affirmation commerciale) | Statut « Site non renseigné » distinct de « Aucun site trouvé après vérification » ; formulations prudentes tant que l'utilisateur n'a pas vérifié |
| 3 | Instances Overpass publiques interrogées **4 en parallèle** à chaque recherche : charge multipliée sur une infrastructure partagée, contraire à sa politique d'usage | Élevée (conformité) | Une requête à la fois pour tout le serveur, bascule séquentielle, instance privée configurable (`OVERPASS_URL`) |
| 4 | Une recherche où OpenStreetMap avait échoué restait incomplète **7 jours** | Moyenne | Nouvel essai automatique après 5 minutes |
| 5 | Recherche bloquée jusqu'à la réponse de toutes les sources (jusqu'à 95 s) | Moyenne | Résultats partiels après 3 s, une requête OSM par ville pour tous les métiers, préchargement des 30 grandes villes |
| 6 | SIRENE : rafales de requêtes refusées (429) | Moyenne | Rythme global limité, file prioritaire utilisateurs / tâche de fond, nouvelles tentatives |
| 7 | Aucune limite sur le nombre de **recherches** (coût sans déblocage) | Moyenne (coûts) | Quota quotidien par offre (20 / 200 / 600), la pagination ne consomme rien |
| 8 | Création de comptes gratuits en série possible (5 leads offerts à chaque fois) | Moyenne | 3 comptes par connexion et par jour (IP hachée), adresses jetables refusées |
| 9 | Score d'opportunité opaque | Faible | Score détaillé critère par critère, affiché sur chaque fiche |
| 10 | Ni source ni date affichées sur les fiches | Faible | Source et date de mise à jour sur chaque fiche |
| 11 | Titre Google de l'accueil en minuscules, description trop longue | Faible | Corrigé |
| 12 | `@types/node` absent : erreur dans `tsconfig.json` | Faible | Installé, script `npm run typecheck` |

### Restant à traiter (phases suivantes)

- **Pas d'administration** : aucune vue des utilisateurs, paiements, coûts ou erreurs (phase 5).
- **Offres** : 2 offres payantes codées en dur ; la grille cible (Starter / Pro / Agence, annuel, crédits) n'existe pas (phase 3).
- **Paiement échoué** : `past_due` garde l'accès sans délai de grâce défini ni relance (phase 3).
- **Pas d'export des données personnelles** pour l'utilisateur (suppression seulement) (phase 5).
- **Envoi d'emails** : uniquement copier / ouvrir la messagerie ; pas d'historique, pas de liste de suppression par utilisateur (phases 2-3).
- **Sauvegardes** de la base SQLite non automatisées (phase 5).
- **Pages légales** : identité de l'éditeur et hébergeur à compléter (`LEGAL_NAME`, `LEGAL_CONTACT`, mention « hébergeur communiqué sur demande » à remplacer).

## Sécurité : points vérifiés

| Point | État |
|---|---|
| Injections SQL | Requêtes préparées partout ; les seules valeurs concaténées sont des constantes internes. Préfixes de zone validés par expression régulière (testé) |
| XSS | Échappement systématique côté serveur (`esc`) et client (`h`) ; CSP stricte sans script inline |
| CSRF | JSON obligatoire sur les requêtes modifiantes + vérification de l'origine |
| SSRF | Audit de site : refus des IP privées / réservées, ports limités, redirections revérifiées |
| Sessions | Jetons aléatoires 256 bits stockés hachés, expiration 30 jours |
| Mots de passe | scrypt (N=16384), comparaison à temps constant, pas d'énumération par le temps de réponse |
| Webhooks Stripe | Signature HMAC vérifiée, tolérance 5 min, idempotence par identifiant d'événement |
| Isolation | Leads, favoris et vérifications filtrés par `user_id` ; la vérification de site d'un utilisateur ne modifie jamais la fiche partagée (testé) |
| Limitation de débit | Connexion (10 / 15 min / IP), recherche (40 / min / utilisateur), autocomplétion (120 / min / IP), quota quotidien de recherches |
| Secrets | Uniquement en variables d'environnement ; aucune clé côté navigateur |

## Sources de données : conditions d'utilisation

| Source | Usage dans SitoLead | Conditions | Conclusion |
|---|---|---|---|
| OpenStreetMap (données) | Commerces et artisans, contacts publics | Licence ODbL : attribution obligatoire | Conforme (attribution présente sur le site et la carte) |
| Overpass (instances publiques) | Requêtes par commune | Usage modéré, pas d'usage intensif en production | **En production : instance Overpass privée ou import d'un extrait OSM** (voir `DEPLOIEMENT.md`) |
| Tuiles OSM (`tile.openstreetmap.org`) | Fond de carte | Pas d'usage intensif, attribution | Acceptable en développement ; **fournisseur de tuiles en production** (`MAP_TILE_URL`) |
| Nominatim | Non utilisé | 1 req/s, autocomplétion interdite | Remplacé par geo.api.gouv.fr (officiel, sans ces limites) |
| API Recherche d'entreprises (SIRENE) | Créations récentes, oppositions | Licence Ouverte 2.0, 7 req/s | Conforme ; les oppositions à la prospection sont respectées |
| geo.api.gouv.fr | Communes, départements, régions | Licence Ouverte, gratuit | Conforme |
| **Google Places API** | **Non intégré** | Payant ; les conditions de Google Maps Platform interdisent de stocker ou de mettre en cache le contenu des fiches (seul l'identifiant de lieu est stockable sans limite, les coordonnées 30 jours) | **Incompatible avec une base de prospects stockée et revendue.** Usage envisageable seulement à la demande, sans stockage, pour aider l'utilisateur à vérifier un site. **Décision à prendre** (voir `SUIVI.md`) |

Conditions Google vérifiées le 24/11/2026 : [Policies and attributions for Places API](https://developers.google.com/maps/documentation/places/web-service/policies),
[Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms),
[conditions spécifiques EEE](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms) (identifiant de lieu stockable sans limite ;
latitude et longitude en cache 30 jours consécutifs au plus ; les autres contenus ne sont pas stockables).
