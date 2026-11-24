// Métiers ciblés (clés OpenStreetMap + code NAF pour le registre SIRENE) et
// villes mises en avant dans les pages SEO.

export interface Trade {
  slug: string;
  label: string;
  plural: string;
  osm: [string, string];
  naf: string;
  /** Ce qu'un site rapporte concrètement à ce métier (utilisé dans les pitchs et les pages SEO). */
  benefit: string;
}

export const TRADES: Trade[] = [
  { slug: 'plombier', label: 'Plombier', plural: 'plombiers', osm: ['craft', 'plumber'], naf: '43.22A', benefit: 'recevoir les demandes de dépannage urgentes tapées sur Google' },
  { slug: 'electricien', label: 'Électricien', plural: 'électriciens', osm: ['craft', 'electrician'], naf: '43.21A', benefit: 'capter les demandes de devis et de dépannage du secteur' },
  { slug: 'boulangerie', label: 'Boulangerie', plural: 'boulangeries', osm: ['shop', 'bakery'], naf: '10.71C', benefit: 'afficher horaires, commandes de gâteaux et produits du moment' },
  { slug: 'coiffeur', label: 'Coiffeur', plural: 'coiffeurs', osm: ['shop', 'hairdresser'], naf: '96.02A', benefit: 'prendre des rendez-vous en ligne 24 h/24' },
  { slug: 'restaurant', label: 'Restaurant', plural: 'restaurants', osm: ['amenity', 'restaurant'], naf: '56.10A', benefit: 'montrer la carte, prendre des réservations et remonter sur « restaurant près de moi »' },
  { slug: 'garage', label: 'Garage auto', plural: 'garages', osm: ['shop', 'car_repair'], naf: '45.20A', benefit: 'recevoir des demandes de devis entretien et réparation' },
  { slug: 'fleuriste', label: 'Fleuriste', plural: 'fleuristes', osm: ['shop', 'florist'], naf: '47.76Z', benefit: 'vendre des bouquets et livraisons en ligne' },
  { slug: 'institut-beaute', label: 'Institut de beauté', plural: 'instituts de beauté', osm: ['shop', 'beauty'], naf: '96.02B', benefit: 'remplir l’agenda avec la réservation en ligne' },
  { slug: 'boucherie', label: 'Boucherie', plural: 'boucheries', osm: ['shop', 'butcher'], naf: '47.22Z', benefit: 'prendre les commandes de fêtes et de barbecue' },
  { slug: 'menuisier', label: 'Menuisier', plural: 'menuisiers', osm: ['craft', 'carpenter'], naf: '43.32A', benefit: 'montrer ses réalisations et recevoir des demandes de devis' },
  { slug: 'climaticien', label: 'Climatisation', plural: 'climaticiens', osm: ['craft', 'hvac'], naf: '43.22B', benefit: 'recevoir les demandes d’installation et d’entretien de climatisation' },
  { slug: 'couvreur', label: 'Couvreur', plural: 'couvreurs', osm: ['craft', 'roofer'], naf: '43.91B', benefit: 'rassurer avec des photos de chantiers et recevoir des demandes de devis toiture' },
  { slug: 'peintre', label: 'Peintre en bâtiment', plural: 'peintres en bâtiment', osm: ['craft', 'painter'], naf: '43.34Z', benefit: 'présenter ses chantiers avant/après et décrocher des devis' },
  { slug: 'macon', label: 'Maçon', plural: 'maçons', osm: ['craft', 'builder'], naf: '43.99C', benefit: 'rassurer les particuliers avec des références et des avis' },
  { slug: 'paysagiste', label: 'Paysagiste', plural: 'paysagistes', osm: ['craft', 'gardener'], naf: '81.30Z', benefit: 'présenter ses jardins et recevoir des demandes d’entretien' },
  { slug: 'photographe', label: 'Photographe', plural: 'photographes', osm: ['craft', 'photographer'], naf: '74.20Z', benefit: 'vendre ses prestations avec un vrai portfolio' },
  { slug: 'agence-immobiliere', label: 'Agence immobilière', plural: 'agences immobilières', osm: ['office', 'estate_agent'], naf: '68.31Z', benefit: 'récupérer des mandats grâce à l’estimation en ligne' },
  { slug: 'avocat', label: 'Avocat', plural: 'avocats', osm: ['office', 'lawyer'], naf: '69.10Z', benefit: 'être trouvé sur sa spécialité et sa ville' },
  { slug: 'kinesitherapeute', label: 'Kinésithérapeute', plural: 'kinésithérapeutes', osm: ['healthcare', 'physiotherapist'], naf: '86.90E', benefit: 'informer les patients et simplifier la prise de rendez-vous' },
  { slug: 'auto-ecole', label: 'Auto-école', plural: 'auto-écoles', osm: ['amenity', 'driving_school'], naf: '85.53Z', benefit: 'afficher tarifs et formules et recevoir des inscriptions' },
];

export const tradeBySlug = (slug: string) => TRADES.find((t) => t.slug === slug);

export interface City {
  code: string; // code INSEE
  name: string;
  slug: string;
  dep: string;
}

const c = (code: string, name: string, slug: string, dep: string): City => ({ code, name, slug, dep });

/** Villes avec une page SEO dédiée. Toute autre commune reste cherchable dans l'app. */
export const CITIES: City[] = [
  c('75056', 'Paris', 'paris', '75'),
  c('13055', 'Marseille', 'marseille', '13'),
  c('69123', 'Lyon', 'lyon', '69'),
  c('31555', 'Toulouse', 'toulouse', '31'),
  c('06088', 'Nice', 'nice', '06'),
  c('44109', 'Nantes', 'nantes', '44'),
  c('34172', 'Montpellier', 'montpellier', '34'),
  c('67482', 'Strasbourg', 'strasbourg', '67'),
  c('33063', 'Bordeaux', 'bordeaux', '33'),
  c('59350', 'Lille', 'lille', '59'),
  c('35238', 'Rennes', 'rennes', '35'),
  c('51454', 'Reims', 'reims', '51'),
  c('83137', 'Toulon', 'toulon', '83'),
  c('42218', 'Saint-Étienne', 'saint-etienne', '42'),
  c('38185', 'Grenoble', 'grenoble', '38'),
  c('21231', 'Dijon', 'dijon', '21'),
  c('49007', 'Angers', 'angers', '49'),
  c('30189', 'Nîmes', 'nimes', '30'),
  c('74010', 'Annecy', 'annecy', '74'),
  c('37261', 'Tours', 'tours', '37'),
  c('63113', 'Clermont-Ferrand', 'clermont-ferrand', '63'),
  c('13001', 'Aix-en-Provence', 'aix-en-provence', '13'),
  c('29019', 'Brest', 'brest', '29'),
  c('87085', 'Limoges', 'limoges', '87'),
  c('57463', 'Metz', 'metz', '57'),
  c('66136', 'Perpignan', 'perpignan', '66'),
  c('25056', 'Besançon', 'besancon', '25'),
  c('45234', 'Orléans', 'orleans', '45'),
  c('76540', 'Rouen', 'rouen', '76'),
  c('14118', 'Caen', 'caen', '14'),
];

export const cityBySlug = (slug: string) => CITIES.find((x) => x.slug === slug);
export const cityByCode = (code: string) => CITIES.find((x) => x.code === code);
