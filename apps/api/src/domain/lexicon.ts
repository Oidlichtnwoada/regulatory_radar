/**
 * Multilingual concept lexicon of the deterministic (offline) classifier. Each concept maps folded
 * (lower-case, accent-free) word stems in several EU languages onto NACE Rev. 2.1 codes. This is a
 * best-effort fallback for when no LLM is configured, not the primary relevance method.
 */
export interface Concept {
  /** Short human-readable label used in "why relevant". */
  readonly label: string;
  /** NACE codes the concept concerns ('*' = every sector). */
  readonly nace: readonly string[];
  /** Word-start stems (folded). */
  readonly terms: readonly string[];
  /** Phrases removed before matching this concept because they contain a misleading term. */
  readonly exclude?: readonly string[];
  /** Strongest verdict the concept may give: set for links that touch only a minority of the sector. */
  readonly cap?: 'borderline';
}

/** Signals that a group creates no duty for anyone (classification-only acts, voluntary schemes). */
export interface NoDutySignal {
  /** Short reason, used in rationales. */
  readonly label: string;
  /** Word-start stems (folded). */
  readonly terms: readonly string[];
}

/** Groups with one of these signals are capped at borderline, like information-only items. */
export const NO_DUTY_SIGNALS: readonly NoDutySignal[] = [
  {
    label: 'EU Taxonomy screening criteria, a green-finance classification without obligations',
    terms: ['2020/852', 'technical screening criteria', 'sustainable finance'],
  },
  {
    label: 'voluntary scheme',
    terms: ['voluntary', 'freiwillig', 'voluntari', 'volontaire', 'dobrowoln'],
  },
];

/** The concept lexicon (en, de, es, fr, pl, it, nl stems). */
export const CONCEPTS: readonly Concept[] = [
  {
    label: 'iron and steel',
    nace: ['C24.1', 'C24.2', 'C24.3'],
    terms: [
      'steel',
      'iron and steel',
      // Not a bare 'ferro': it also starts railway words (ferroviario, ferroviaire, ferrocarril).
      'ferrous metal',
      'ferroall',
      'ferroalea',
      'ferroleg',
      'stahl',
      'acero',
      'siderurg',
      'acier',
      // Polish steel forms only: a bare 'stal' also starts 'staly' (permanent) and English 'stale' / 'stall'.
      'stal ',
      'stali ',
      'stalow',
      'acciai',
      'staal',
    ],
    exclude: ['iron curtain', 'adding iron', 'non-ferrous', 'non ferrous'],
  },
  {
    label: 'non-ferrous metals',
    nace: ['C24.4'],
    terms: [
      'alumin',
      'nickel',
      'cobalt',
      'copper',
      'kupfer',
      'cobre',
      'cuivre',
      'miedz',
      'zinc',
      'zink',
      'nichteisen',
      'non-ferrous',
      'raw materials',
      'rohstoff',
      'materias primas',
    ],
  },
  {
    label: 'foundries and smelters',
    nace: ['C24.5', 'C24.4'],
    terms: [
      'foundr',
      'casting of metal',
      'giesserei',
      'fundicion',
      'fonderie',
      'odlewn',
      'schmelz',
      'smelt',
      'refiner',
    ],
  },
  {
    label: 'fabricated metal products',
    nace: ['C25'],
    terms: [
      'screws',
      'bolts',
      'fastener',
      'metal products',
      'metalwork',
      'reinforcing',
      'schrauben',
      'metalurg',
    ],
  },
  {
    label: 'scrap metal',
    nace: ['C24', 'E38'],
    terms: ['scrap', 'schrott', 'altmetall', 'chatarra', 'ferraille', 'zlom', 'rottam'],
  },
  {
    label: 'energy- and emission-intensive industry',
    nace: ['C24', 'C20', 'C23', 'C17'],
    terms: [
      'energy-intensive',
      'electricity-intensive',
      'energieintensiv',
      'stromintensiv',
      'intensivas en energia',
      'electro-intensi',
      'energochlonn',
      'emissions trading',
      'emission allowances',
      'emissionshandel',
      'free allocation',
      'free-allocation',
      'carbon border',
      'carbon leakage',
      'indirect emission',
      'indirekter co2',
      'co2-kosten',
      'grossabnehmer',
      'large industrial',
      'hochspannung',
      'energieaudit',
      'energy audit',
    ],
  },
  {
    label: 'retail trade and consumer sales',
    nace: ['G47'],
    terms: [
      'retail',
      'shop',
      'store',
      'consumer',
      'point of sale',
      'checkout',
      'at the till',
      'marketplace',
      'price reduction',
      'drip pricing',
      'unit price',
      'einzelhandel',
      'geschaft',
      'verbraucher',
      'offnungszeit',
      'ladenoffnung',
      'comercio minorista',
      'minorista',
      'horarios comerciales',
      'tienda',
      'establecimientos abiertos al publico',
      'consumidor',
      'punto de venta',
      'venta a distancia',
      'ventas a distancia',
      'precio por unidad',
      'commerce de detail',
      'commerces de detail',
      'consommat',
      'ouverture dominicale',
      'sklep',
      'konsument',
      'handlu w niedziel',
      'handel w niedziel',
      'negozi',
      'consumator',
      'winkel',
    ],
    // Consumer protection alone also covers finance, travel and telecoms; industrial consumers are not shoppers.
    exclude: [
      'retail invest',
      'industrial consumers',
      'industrial gas consumers',
      'consumer protection',
      'comercio exterior',
      // 'store' as a verb or a building storey, not a shop.
      'stored',
      'storey',
      'energy store',
    ],
  },
  {
    label: 'packaging and take-back',
    nace: ['G47', 'G46', 'C22', 'C17'],
    terms: [
      'packaging',
      'containers',
      'deposit-return',
      'verpackung',
      'pfand',
      'envase',
      'emballage',
      'opakowan',
    ],
  },
  {
    label: 'food and agriculture',
    nace: ['C10', 'A01'],
    terms: [
      'food',
      'flour',
      'honey',
      'lebensmittel',
      'alimentar',
      'alimentos',
      'zywnosc',
      'miod',
      'cereal',
      'getreide',
      'zboz',
      'farm ',
      'farm-',
      'farms',
      'farmer',
      'farming',
      'farmland',
      'agricultur',
      'landwirtschaft',
      'rolnict',
      'rolnych',
      'gospodarstw',
    ],
  },
  // Marginal agri-food links: only some large food plants or suppliers are affected, so borderline at most.
  {
    label: 'emissions trading and large gas users (some large food plants)',
    nace: ['C10'],
    cap: 'borderline',
    terms: [
      'emissions trading',
      'emission allowances',
      'free allocation',
      'free-allocation',
      'emissionshandel',
      'derechos de emision',
      'industrial gas consumers',
    ],
  },
  {
    label: 'reusable transport packaging (crates and pallets of food suppliers)',
    nace: ['C10', 'A01'],
    cap: 'borderline',
    terms: ['transport packaging', 'crates', 'pallet', 'transportverpackung', 'skrzyn'],
  },
  {
    label: 'pack sizes of consumer goods (food products)',
    nace: ['C10'],
    cap: 'borderline',
    terms: ['shrinkflation', 'pack size', 'package downsizing', 'packungsgrosse'],
  },
  {
    label: 'energy supply',
    nace: ['D35'],
    terms: ['electricity supply', 'gas supply', 'netzentgelt', 'grid fee', 'security of gas', 'strompreis'],
  },
  {
    label: 'construction',
    nace: ['F41', 'F42'],
    terms: ['construction', 'hochbau', 'bruckenbau', 'construccion', 'batiment'],
  },
  {
    label: 'financial services',
    nace: ['L64', 'L66'],
    // Tax and carbon credits are not lending.
    exclude: ['tax credit', 'credito fiscal', "credit d'impot", 'carbon credit', 'steuergutschrift'],
    terms: [
      'credit',
      'payment services',
      'investor',
      'banks',
      'insurer',
      'kredit',
      'credito',
      'medios de pago',
    ],
  },
  {
    label: 'obligations for all businesses',
    nace: ['*'],
    terms: [
      'late payment',
      'payment terms',
      'between businesses',
      'zahlungsverzug',
      'morosidad',
      'factura electronica',
      'e-invoic',
      'entre empresarios',
      'pequenas empresas',
      'microempresas',
      'smes',
      'kmu',
      'grossunternehmen',
      'large companies',
      'pagos en efectivo',
    ],
  },
];
