# Coûts et rentabilité de SitoLead — 24 novembre 2026

Estimation des coûts variables et fixes, pour valider la grille d'offres. Chaque chiffre indique
sa source : **vérifié** (tarif officiel consulté à cette date), **mesurable** (l'application
l'enregistre, à confirmer sur l'usage réel) ou **hypothèse** (à vérifier avant d'engager une dépense).

## Coûts variables

| Poste | Coût unitaire | Source |
|---|---|---|
| Paiement Stripe, carte européenne standard | 1,5 % + 0,25 € par paiement | Vérifié ([tarifs Stripe France](https://stripe.com/en-fr/pricing)) |
| Stripe Billing (abonnements) | 0,7 % du montant facturé | Vérifié ([Stripe Billing](https://stripe.com/billing/pricing)) |
| Carte premium EEE / hors EEE | 2,8 % + 0,25 € / 3,15 % + 0,25 € | Vérifié ([tarifs Stripe France](https://stripe.com/en-fr/pricing)) |
| Données des entreprises (OpenStreetMap, SIRENE, geo.api.gouv.fr) | 0 € | Vérifié : sources publiques gratuites |
| Rédaction IA d'une maquette (Claude Opus 5.5 : 4 $ / 20 $ par million de jetons) | ≈ 0,015 $ (≈ 900 jetons en entrée, ≈ 550 en sortie) | Tarif vérifié ; consommation **mesurable** (table `ai_usage`) |
| Maquette hébergée (page servie par le serveur principal) | ≈ 0 € (quelques Ko en base) | Mesurable |
| Image de maquette | 1,5 Mo maximum sur le disque du serveur | Mesurable |
| Email de prospection | 0 € : envoyé par l'utilisateur depuis sa propre messagerie | Vérifié (aucun envoi par SitoLead) |
| Recherche | ≈ 0 € en argent ; charge sur l'instance OpenStreetMap | Mesurable |

## Coût d'un client qui utilise tout son quota (par mois)

| Offre | Prix HT | Stripe (≈) | IA au quota maximum | Coût variable total | Marge brute |
|---|---:|---:|---:|---:|---:|
| Découverte | 0 € | 0 € | 3 × 0,015 $ ≈ 0,05 € | ≈ 0,05 € (une fois) | — |
| Starter | 19 € | 0,67 € | 30 × 0,015 $ ≈ 0,42 € | ≈ 1,10 € | ≈ 94 % |
| Pro | 49 € | 1,33 € | 100 × 0,015 $ ≈ 1,40 € | ≈ 2,75 € | ≈ 94 % |
| Agence | 99 € | 2,43 € | 300 × 0,015 $ ≈ 4,20 € | ≈ 6,65 € | ≈ 93 % |

Conversion dollar → euro supposée à environ 0,93 (hypothèse). La marge reste au-dessus de 90 % même
si le coût réel d'une rédaction IA est deux fois plus élevé que l'estimation : l'objectif de 70 % de
marge brute est atteint, à condition de maîtriser les coûts fixes ci-dessous.

Garde-fous déjà en place côté serveur :
- quotas par offre : entreprises, maquettes, rédactions IA, images, recherches par jour ;
- **plafond global de dépense IA par jour** (`AI_DAILY_BUDGET_USD`, 2 $ par défaut) : au-delà, la rédaction IA se coupe pour tout le monde jusqu'au lendemain ;
- aucune offre illimitée ;
- limitation des comptes gratuits créés en série (3 par connexion et par jour, adresses jetables refusées).

## Coûts fixes mensuels (hypothèses, rien n'est souscrit)

| Poste | Démarrage (test) | Production | Remarque |
|---|---:|---:|---|
| Serveur de l'application | 0 € (votre PC) à ≈ 5 € | ≈ 5 à 15 € | Petit serveur virtuel ; à comparer chez plusieurs hébergeurs |
| OpenStreetMap (Overpass) | 0 € (instances publiques, usage modéré) | ≈ 20 à 40 € | Serveur dédié avec l'extrait France, ou import périodique dans la base |
| Fond de carte | 0 € (tuiles OSM, faible trafic) | 0 € puis payant selon trafic | Fournisseur de tuiles avec offre gratuite |
| Nom de domaine | ≈ 1 € | ≈ 1 € | ≈ 10 à 15 € par an |
| Sauvegardes | 0 € | ≈ 1 à 3 € | Copie quotidienne de la base et des images |
| **Total** | **≈ 0 à 6 €** | **≈ 30 à 60 €** | |

**Seuil de rentabilité en production** : 1 à 2 abonnements Pro, ou 2 à 3 abonnements Starter, couvrent les
coûts fixes estimés.

## Recommandation pour la phase de test

Vérifier par soi-même que le démarchage rapporte avant de payer quoi que ce soit est possible sans dépense :
1. Faire tourner SitoLead sur son PC, avec les sources publiques (usage modéré, conforme à leurs règles).
2. Activer l'IA avec sa clé Anthropic et un plafond quotidien bas (par exemple `AI_DAILY_BUDGET_USD=0.5`).
3. Démarcher soi-même et suivre les résultats dans le tableau de bord (contactés, réponses, gagnés, chiffre d'affaires déclaré).
4. Ne souscrire le serveur, l'instance OpenStreetMap et le fournisseur de tuiles qu'au moment d'ouvrir le service à d'autres utilisateurs.

## Restant à chiffrer (phase 4)

Hébergement des **sites définitifs** vendus aux artisans (domaine personnalisé, SSL, sauvegardes,
formulaires) : les offres envisagées (9,90 € / 19,90 € / 29,90 € par site et par mois) seront validées
avec le coût réel par site au moment de la phase 4.
