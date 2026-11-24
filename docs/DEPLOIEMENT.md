# Déploiement de SitoLead

État : guide de la phase 1. Il sera complété en phase 5 (sauvegardes, monitoring, hébergement des sites clients).

## Prérequis

- Node.js **24 ou plus récent** (TypeScript exécuté nativement, `node:sqlite`).
- Un serveur Linux avec un disque persistant pour `data/sitolead.db` (SQLite).
- Un proxy HTTPS devant l'application (Caddy ou Nginx), avec `TRUST_PROXY=1`.

## Installation

```bash
npm ci --omit=dev        # seule dépendance d'exécution : leaflet (déjà copié dans web/)
cp .env.example .env     # puis remplir les valeurs
npm start
```

Le serveur écoute sur `HOST:PORT` (par défaut `127.0.0.1:3000`) ; le proxy HTTPS le publie.
Au premier démarrage, les tables et colonnes manquantes sont créées automatiquement, sans
toucher aux données existantes.

## Variables indispensables en production

| Variable | Rôle |
|---|---|
| `APP_URL` | URL publique en `https://` (active le cookie `Secure`, les liens Stripe, le sitemap) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Paiement ; webhook sur `APP_URL/api/stripe/webhook` |
| `LEGAL_NAME`, `LEGAL_CONTACT` | Mentions légales (à compléter avec l'hébergeur réel) |
| `TRUST_PROXY=1`, `IP_SALT` | IP réelle derrière le proxy, hachage des IP d'inscription |
| `OVERPASS_URL` | **Instance OpenStreetMap privée** (voir ci-dessous) |
| `MAP_TILE_URL`, `MAP_ATTRIBUTION` | **Fournisseur de fond de carte** (voir ci-dessous) |

## OpenStreetMap en production

Les instances Overpass publiques sont partagées et gratuites : leur politique d'usage exclut un
usage intensif de production. Deux options :

1. **Instance Overpass privée** (recommandé pour démarrer) : un serveur dédié avec l'extrait
   France (Geofabrik) ; compter environ 60 Go de disque et 8 Go de mémoire vive. Renseigner
   son adresse dans `OVERPASS_URL`.
2. **Import périodique** d'un extrait France (fichier `.osm.pbf` filtré avec osmium) directement
   dans la base : plus économique à grande échelle, demande un développement supplémentaire.

Sans `OVERPASS_URL`, l'application reste polie avec les instances publiques : une requête à la
fois, une seule instance interrogée à la fois, relances espacées.

## Fond de carte en production

Les tuiles `tile.openstreetmap.org` ne doivent pas servir à un usage intensif. Choisir un
fournisseur de tuiles (offre gratuite limitée puis payante), renseigner son URL dans
`MAP_TILE_URL` (format `https://…/{z}/{x}/{y}.png`) et l'attribution exigée dans
`MAP_ATTRIBUTION`. L'origine des tuiles est ajoutée automatiquement à la politique de sécurité (CSP).

## Compte administrateur

```bash
npm run admin -- vous@exemple.fr
```

Crée le compte (mot de passe provisoire affiché une seule fois, à changer dans Profil) ou donne le
rôle administrateur à un compte existant. L'onglet **Admin** apparaît alors dans l'application.

## Sauvegardes

Le serveur copie la base chaque jour dans `BACKUP_DIR` (`data/backups` par défaut) et garde les 14
plus récentes (`BACKUP=0` pour désactiver). Une sauvegarde à la demande est possible depuis l'espace
Admin. **Recopiez régulièrement `data/backups` et `data/uploads` (images) hors du serveur.**
