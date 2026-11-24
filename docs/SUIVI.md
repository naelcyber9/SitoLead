# Suivi du projet SitoLead

Mis à jour à chaque étape. Légende : ✅ terminé · 🟡 partiel · ⬜ à faire · ⛔ bloqué (décision ou accès externe requis).

## Phase 1 — Stabilisation ✅

| Élément | État | Détail |
|---|---|---|
| Audit | ✅ | [AUDIT.md](AUDIT.md) |
| Corrections de bugs | ✅ | Arrondissements SIRENE, statuts de site, relance des recherches incomplètes, quotas SIRENE (voir audit) |
| Recherche commune / code postal | ✅ | Autocomplétion geo.api.gouv.fr |
| Recherche département / région | ✅ | Affichage depuis la base, collecte des 5 communes les plus peuplées, 150 suivantes en file de fond, couverture affichée |
| Recherche par rayon | ✅ | 5 à 50 km autour d'une commune (départements limitrophes inclus) |
| Carte interactive | ✅ | Leaflet, marqueurs colorés par score, liste ↔ carte synchronisées, positions arrondies (~1 km) tant que la fiche est verrouillée |
| Filtres avancés | ✅ | État du site, score minimum, coordonnées (téléphone / email), source, favoris, créations récentes |
| Favoris | ✅ | Par utilisateur, utilisables avant déblocage |
| Statuts de site | ✅ | Non renseigné · Aucun site après vérification · Existant · Potentiellement obsolète · Inaccessible · Non vérifié · Réseau social seulement |
| Vérification par l'utilisateur | ✅ | « Aucun site trouvé » ou « Site trouvé » (audité), propre à son compte ; le message s'adapte |
| Score explicable | ✅ | Détail des points par critère réel (site, contacts, création, fraîcheur) |
| Source et date | ✅ | Sur chaque fiche |
| Déduplication | ✅ | Par SIRET entre OSM et SIRENE (existant, conservé) |
| Quotas de recherche | ✅ | 20 / 200 / 600 recherches distinctes par jour selon l'offre |
| Anti-abus comptes gratuits | ✅ | 3 comptes / connexion / jour, adresses jetables refusées |
| Respect des instances publiques OSM | ✅ | Une requête à la fois, bascule séquentielle, `OVERPASS_URL` pour une instance privée |
| Google Places | ⛔ | Non intégré : conditions incompatibles avec le stockage (voir audit). Décision à prendre |
| International | 🟡 | Architecture par « zones » extensible ; référentiel et sources limités à la France |

Tests : **39 tests, 39 réussis** · vérification TypeScript : **aucune erreur** · essai réel dans le navigateur : recherche « plombiers, Haute-Savoie » avec carte, sans erreur console.

## Phase 2 — Maquettes (fonctionnalité principale) 🟡

| Élément | État | Détail |
|---|---|---|
| Moteur de templates mutualisé | ✅ | `src/mockups.ts` : un seul moteur, contenu JSON en base, aucun projet ni déploiement par prospect |
| Templates sectoriels | ✅ | Plomberie, électricité, climatisation, maçonnerie / bâtiment, couverture, paysagisme, automobile, restauration, coiffure / esthétique, commerce, services (générique). Métiers « climaticien » et « couvreur » ajoutés au catalogue |
| Contenu honnête | ✅ | Données réelles du prospect ; prestations = suggestions à valider ; aucun avis, certification, tarif ni ancienneté ; horaires seulement si saisis ; test automatique |
| Images | ✅ | Illustrations vectorielles maison (aucune image tierce). Envoi de photos / logo : ⬜ (nécessite un stockage de fichiers) |
| « Générer une maquette » sur la fiche | ✅ | Réservé aux entreprises débloquées ; quota 1 (gratuit) / 50 / 150 par mois |
| Éditeur | ✅ | Secteur, textes, prestations, zone, coordonnées, horaires, bouton, couleurs, illustration, sections ; aperçu ordinateur / mobile |
| Lien de prévisualisation | ✅ | `/p/<id>` (128 bits aléatoires), sans compte ; expiration 7 / 30 / 90 jours ; révocation / réactivation ; `noindex` (balise, en-tête, robots.txt) ; bandeau « non officielle » + contact du créateur ; formulaire de démonstration ; compteur de visites (hors créateur) |
| Sécurité de la page publique | ✅ | CSP dédiée sans script, contenu échappé, couleurs validées, affichage dans l'éditeur seulement depuis SitoLead |
| Mail de prospection | ✅ | Lien de la maquette active inséré automatiquement, prix proposé, objet et texte modifiables avant envoi, copie ou ouverture de la messagerie |
| RGPD | ✅ | Une demande de suppression de l'entreprise supprime aussi ses maquettes |
| Textes générés par IA | ⛔ | Décision en attente : fournisseur et budget plafonné |
| Envoi depuis SitoLead / messagerie connectée | ⬜ | Phase 3 (fournisseur transactionnel, liste de suppression, limites d'envoi) |

Tests : **44 tests, 44 réussis** · TypeScript : **aucune erreur** · essai réel : génération, éditeur (ordinateur et mobile), page publique sans compte, aucune erreur console.

### Compléments phase 2 ✅

| Élément | Détail |
|---|---|
| Rédaction par IA | Claude Opus 5.5 (SDK officiel, sortie JSON structurée, effort faible), sur la clé et le crédit Anthropic de l'exploitant. Désactivée sans `ANTHROPIC_API_KEY`. Quota mensuel par offre + plafond global quotidien (`AI_DAILY_BUDGET_USD`). Consignes anti-invention + filtre serveur des affirmations invérifiables. Suggestions relues avant enregistrement |
| Photos et logo | Stockés sur le disque du serveur (aucun service payant), type réel vérifié, 1,5 Mo max, EXIF retiré, quota par offre, une maquette n'affiche que les images de son propriétaire, déclaration de droits d'utilisation |

## Phase 3 — Commercialisation ✅ (hors administration de la grille, phase 5)

| Élément | État | Détail |
|---|---|---|
| Statuts du suivi | ✅ | Lead débloqué, maquette générée (automatique), contacté, relance prévue, réponse reçue, en négociation, gagné, perdu, ne plus contacter ; anciens statuts convertis |
| Vue en colonnes | ✅ | Glisser-déposer + menu accessible au clavier, vue liste, filtre par statut |
| Historique, notes, rappels | ✅ | Historique par prospect, rappels du jour et en retard ; « ne plus contacter » coupe relances et envoi |
| Statistiques réelles | ✅ | Leads, maquettes et visites, messages préparés, contactés, réponses, gagnés, conversion, chiffre d'affaires **déclaré** |
| Grille d'offres | ✅ | Gratuit / Starter 19 € / Pro 49 € / Agence 99 € HT par mois, annuel = 10 mois ; quotas d'entreprises, maquettes, IA, images, recherches |
| Packs de crédits | ✅ | 50 entreprises (19 €) / 150 (45 €), sans limite de durée, utilisés après le quota de l'offre, ajout unique par paiement |
| Paiement échoué | ✅ | Accès maintenu 7 jours, alerte dans l'espace Abonnement, puis retour à l'offre gratuite sans perte de données ; rétabli au paiement |
| Portail client, résiliation, changement d'offre | ✅ | Portail Stripe (existant) |
| Webhooks | ✅ | Signés, idempotents ; `invoice.paid` ajouté |
| Calcul des coûts | ✅ | [COUTS.md](COUTS.md) : marge brute ≈ 93-94 % au quota maximum, seuil de rentabilité 1 à 2 abonnements Pro |
| Grille modifiable depuis l'administration | ⬜ | Phase 5 (aujourd'hui dans `src/billing.ts`) |
| Envoi d'emails depuis SitoLead, campagnes | ⬜ | Volontairement non fait : pas de fournisseur payant pendant la phase de test ; l'utilisateur envoie depuis sa messagerie |

Tests : **56 tests, 56 réussis** · TypeScript : **aucune erreur**.

## Phase 4 — Sites vendus : export seulement ✅ (décision du 24/11/2026)

SitoLead reste un outil de prospection : une fois le client signé, le développeur construit et héberge
le site comme il le souhaite. L'hébergement des sites clients par SitoLead (domaines, SSL, facturation
de l'hébergement, choix du payeur) n'est **pas** développé ; il pourra l'être si des utilisateurs le demandent.

| Élément | État | Détail |
|---|---|---|
| Télécharger la maquette en HTML | ✅ | Fichier autonome (styles et images intégrés), sans bandeau « proposition », indexable ; commentaire indiquant où brancher le formulaire de contact. Réservé au propriétaire |
| Hébergement par SitoLead | ✖ | Écarté pour l'instant (coûts fixes et responsabilité sans revenu garanti) |

## Phase 5 — Finalisation 🟡

| Élément | État | Détail |
|---|---|---|
| Compte administrateur | ✅ | Rôle `admin` ; `npm run admin -- email` crée le compte (mot de passe provisoire affiché une fois) ou donne le rôle à un compte existant |
| Espace Admin | ✅ | Utilisateurs par offre, inscriptions, revenu mensuel estimé, impayés, déblocages, maquettes, dépense IA (jour / 30 jours / plafond), base, file OpenStreetMap, oppositions, stockage des images, erreurs ; alertes de consommation anormale ; recherche d'utilisateurs ; crédits offerts (tracés) ; suppression RGPD d'une entreprise ; sauvegarde à la demande. Routes invisibles (404) pour les autres comptes |
| Journal des erreurs | ✅ | Route et message, sans identifiant ni donnée personnelle, conservé 30 jours |
| Changement de mot de passe | ✅ | Ancien mot de passe vérifié, autres sessions fermées |
| Export RGPD | ✅ | « Télécharger mes données » (JSON) : compte, prospects, notes, historique, favoris, maquettes, images, crédits, usage IA |
| Sauvegardes | ✅ | Copie cohérente quotidienne (`VACUUM INTO`) dans `data/backups`, 14 conservées ; à recopier hors du serveur avec `data/uploads` |
| Grille d'offres modifiable depuis l'administration | ⬜ | Aujourd'hui dans `src/billing.ts` (modification = nouvelle version) |
| Monitoring externe (disponibilité) | ⬜ | À brancher au déploiement (service de surveillance gratuit) |

## Décisions en attente

| Sujet | Question | Impact |
|---|---|---|
| Google Places | Intégrer une vérification à la demande (sans stockage) ? Coût par requête à valider sur la grille Google en vigueur | Fiabilité du statut « aucun site » |
| Infrastructure OSM de production | Instance Overpass privée (serveur dédié, ~60 Go) ou import périodique d'un extrait France dans la base ? | Indispensable avant un trafic réel |
| Fournisseur de tuiles | Choisir un fournisseur de fond de carte (offre gratuite puis payante) | Indispensable avant un trafic réel |
| IA pour les textes de maquette | Fournisseur et budget mensuel plafonné | Phase 2 |
| Envoi d'emails depuis SitoLead | Fournisseur transactionnel compatible avec la prospection B2B | Phase 2-3 |

## Blocages

Aucun blocage technique. Les points ⛔ attendent une décision ou un accès externe (clés API, comptes fournisseurs).
