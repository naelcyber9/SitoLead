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

## Phase 3 — Commercialisation ⬜

CRM complet (statuts étendus, Kanban, historique, rappels), statistiques réelles, grille d'offres configurable
(Starter / Pro / Agence, mensuel / annuel), packs de crédits, gestion des paiements échoués, calcul des coûts.

## Phase 4 — Hébergement des sites vendus ⬜

Conversion maquette → site, export, hébergement mutualisé, domaine personnalisé + SSL, choix du payeur,
facturation distincte de la prospection.

## Phase 5 — Finalisation ⬜

Administration, export des données personnelles, sauvegardes, monitoring, documentation de déploiement complète.

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
