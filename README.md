# SitoLead

Plateforme de prospection pour freelances, développeurs web et agences : elle trouve les
entreprises locales sans site ou avec un site à refaire, donne leurs coordonnées
professionnelles publiques, audite leur site et prépare le message pour les contacter.

## Démarrer en local

Prérequis : **Node.js 24+**.

```bash
npm install
cp .env.example .env    # facultatif en local
npm start               # http://localhost:3000
```

Sans configuration, l'application fonctionne avec les sources publiques gratuites et sans
paiement (les boutons d'abonnement affichent un message tant que Stripe n'est pas configuré).

## Commandes

| Commande | Rôle |
|---|---|
| `npm start` | Lance le serveur |
| `npm test` | Tests automatisés (`node --test`) |
| `npm run typecheck` | Vérification TypeScript |
| `npm run seed -- annecy plombier` | Pré-remplit la base pour une ville (et des métiers) |
| `node src/cli/optout.ts <siret\|email\|téléphone>` | Enregistre une demande de suppression |

## Organisation du code

| Dossier / fichier | Contenu |
|---|---|
| `src/server.ts` | Serveur HTTP : pages publiques, application, API JSON, webhook Stripe |
| `src/prospects.ts` | Collecte, cache, préchargement, recherche, déblocage, favoris, vérification de site |
| `src/sources.ts` | Sources : OpenStreetMap (Overpass), SIRENE, communes |
| `src/zones.ts` | Recherche par département, région, rayon ; file de collecte |
| `src/scoring.ts` | Score d'opportunité expliqué, statuts, messages de prospection |
| `src/audit.ts` | Audit des sites existants (protégé contre le SSRF) |
| `src/billing.ts` | Offres, quotas, Stripe |
| `src/seo.ts` | Pages publiques et SEO |
| `web/` | Application (HTML, CSS, JS sans framework) et Leaflet |
| `docs/` | [Audit](docs/AUDIT.md), [suivi](docs/SUIVI.md), [déploiement](docs/DEPLOIEMENT.md) |

## Données

Sources publiques et officielles : OpenStreetMap (© contributeurs OpenStreetMap, licence ODbL)
et l'Annuaire des entreprises (SIRENE, Licence Ouverte 2.0). Les listes ne sont pas exhaustives,
et l'application l'indique toujours. Les entreprises opposées à la prospection ne sont jamais proposées.
