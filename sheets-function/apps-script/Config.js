/**
 * Settings shared by every file. Apps Script loads all .js files of a project
 * into one global scope, so the other files use these names directly. They are
 * only read inside functions, because Apps Script does not guarantee the order
 * in which files load.
 *
 * Names ending in "_" are private: Apps Script hides them from the sidebar's
 * google.script.run and from the Run menu.
 */

const CE_API_BASE = 'https://api.companyenrich.com/v2';
const CE_KEY_PROPERTY = 'COMPANYENRICH_API_KEY';

const CE_BATCH_SIZE = 50; // POST /v2/companies/enrich/batch takes at most 50 domains
const CE_CACHE_SECONDS = 21600; // 6 hours, the longest CacheService keeps anything
const CE_MAX_RETRIES = 2; // same retry budget as the official SDK
const CE_PARALLEL_REQUESTS = 4; // cap for UrlFetchApp.fetchAll fan-out
const CE_MAX_LOOKALIKES = 25;
const CE_MAX_PEOPLE_DOMAINS = 25;
const CE_MAX_PEOPLE_PER_COMPANY = 10;
const CE_MAX_TITLES = 10;

// Custom functions must return within 30 seconds; lock waits and retries count
// too. After this long a formula starts no new paid calls and shows the rest
// as deferred. The sidebar runs under the 6-minute script limit instead.
const CE_FORMULA_TIME_BUDGET_MS = 20000;
const CE_SIDEBAR_TIME_BUDGET_MS = 240000;
const CE_POLL_MS = 500; // how often a cell checks on a domain another cell is fetching

/** Credits per returned record, from the v2 API reference. */
const CE_COST = Object.freeze({ enrich: 1, lookalike: 5, person: 2 });

/** What a cell shows when a domain has no company behind it. */
const CE_TEXT = Object.freeze({
  notFound: 'Not found',
  invalidDomain: 'Invalid domain',
  pending: 'Pending: recalculate later',
  deferred: 'Pending: too many new domains for one formula. Recalculate, or use the sidebar',
});

/**
 * Company fields that formulas and the sidebar can return, as paths into the
 * v2 company response. `pick` marks the sidebar's default selection.
 * @type {ReadonlyArray<{path: string, label: string, pick?: boolean}>}
 */
const CE_FIELDS = Object.freeze([
  { path: 'name', label: 'Name', pick: true },
  { path: 'domain', label: 'Domain' },
  { path: 'website', label: 'Website' },
  { path: 'industry', label: 'Industry', pick: true },
  { path: 'industries', label: 'Industries' },
  { path: 'categories', label: 'Categories' },
  { path: 'employees', label: 'Employees', pick: true },
  { path: 'revenue', label: 'Revenue' },
  { path: 'foundedYear', label: 'Founded' },
  { path: 'type', label: 'Type' },
  { path: 'description', label: 'Description' },
  { path: 'legalName', label: 'Legal name' },
  { path: 'location.country.name', label: 'Country', pick: true },
  { path: 'location.country.code', label: 'Country code' },
  { path: 'location.state.name', label: 'State' },
  { path: 'location.city.name', label: 'City' },
  { path: 'location.address', label: 'Address' },
  { path: 'location.postalCode', label: 'Postal code' },
  { path: 'location.phone', label: 'Phone' },
  { path: 'socials.linkedinUrl', label: 'LinkedIn' },
  { path: 'socials.twitterUrl', label: 'Twitter/X' },
  { path: 'socials.facebookUrl', label: 'Facebook' },
  { path: 'socials.instagramUrl', label: 'Instagram' },
  { path: 'socials.youtubeUrl', label: 'YouTube' },
  { path: 'socials.githubUrl', label: 'GitHub' },
  { path: 'socials.crunchbaseUrl', label: 'Crunchbase' },
  { path: 'socials.angellistUrl', label: 'AngelList' },
  { path: 'socials.g2Url', label: 'G2' },
  { path: 'logoUrl', label: 'Logo URL' },
  { path: 'id', label: 'CompanyEnrich ID' },
  { path: 'updatedAt', label: 'Updated at' },
]);

/** Short names people tend to type in a formula. Keys are lower case. */
const CE_FIELD_ALIASES = Object.freeze({
  country: 'location.country.name',
  countrycode: 'location.country.code',
  state: 'location.state.name',
  city: 'location.city.name',
  linkedin: 'socials.linkedinUrl',
  founded: 'foundedYear',
});

/** Fields that only exist with a paid `expand`. Formulas never request them. */
const CE_EXPANSION_FIELDS = Object.freeze(['financial', 'keywords', 'naicsCodes', 'technologies', 'workforce']);

const CE_EMPLOYEE_RANGES = Object.freeze(['1-10', '11-50', '51-200', '201-500', '501-1K', '1K-5K', '5K-10K', 'over-10K']);

const CE_CATEGORIES = Object.freeze([
  'b2b', 'b2c', 'b2g', 'e-commerce', 'media', 'service-provider', 'mobile', 'saas', 'local-business',
]);

const CE_SENIORITIES = Object.freeze([
  'owner', 'founder', 'c-suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
]);

/** Top-level people departments. Each one includes its sub-departments. */
const CE_DEPARTMENTS = Object.freeze([
  'c-suite', 'product-management', 'engineering-technical', 'design', 'education', 'finance', 'human-resources',
  'information-technology', 'legal', 'marketing', 'medical-health', 'operations', 'sales', 'consulting',
]);

/**
 * A company from the v2 API. Typed loosely: this script only reads fields by path.
 * @typedef {Record<string, any>} Company
 */

/**
 * The outcome of looking up one domain, using the batch endpoint's status names.
 * "deferred" means the formula ran out of time before looking the domain up.
 * @typedef {{status: 'found', company: Company} | {status: 'not-found' | 'invalid-domain' | 'pending' | 'deferred'}} LookupResult
 */
