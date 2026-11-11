/**
 * Two cache layers keep recalculation free:
 *
 * 1. CacheService (document cache): fast, kept for up to 6 hours, may be
 *    dropped earlier by Google.
 * 2. Document properties: saved with the spreadsheet, so a company paid for
 *    once is never billed again when the sheet is reopened or recalculated.
 *    The store holds 500 KB per document; when it fills up, the oldest
 *    quarter of saved companies is dropped.
 *
 * Every entry records the domain it was looked up with, and a read only
 * accepts an entry whose domain matches, so a stale or mismatched entry can
 * never put the wrong company in a cell.
 *
 * "Not found" answers go to CacheService only, so a company that CompanyEnrich
 * adds later is picked up after at most 6 hours. Not-found lookups are free.
 *
 * In-flight markers, also in CacheService, record that a cell is fetching a
 * domain right now, so a second cell waits for it instead of paying again.
 */

const CE_COMPANY_PREFIX = 'ce:company:';
const CE_MISSING_PREFIX = 'ce:missing:';
const CE_INFLIGHT_PREFIX = 'ce:inflight:';
const CE_INFLIGHT_SECONDS = 60; // longer than any custom function runs, so a crashed claim expires
const CE_MAX_PROPERTY_BYTES = 8000; // a property value may be at most 9 KB

/**
 * @param {string[]} domains Normalized domains.
 * @return {{companies: Record<string, Company>, notFound: string[]}}
 */
function readCache_(domains) {
  /** @type {Record<string, Company>} */
  const companies = {};
  /** @type {string[]} */
  const notFound = [];
  if (!domains.length) return { companies, notFound };

  const cache = CacheService.getDocumentCache();
  const keys = domains.flatMap((domain) => [CE_COMPANY_PREFIX + domain, CE_MISSING_PREFIX + domain]);
  const cached = cache ? cache.getAll(keys) : {};
  const misses = [];
  for (const domain of domains) {
    const company = companyFromEntry_(cached[CE_COMPANY_PREFIX + domain], domain);
    if (company) companies[domain] = company;
    else if (cached[CE_MISSING_PREFIX + domain] === domain) notFound.push(domain);
    else misses.push(domain);
  }
  if (!misses.length) return { companies, notFound };

  // One read of the whole store is cheaper than a call per domain.
  const stored = PropertiesService.getDocumentProperties().getProperties();
  /** @type {Record<string, Company>} */
  const fromDocument = {};
  for (const domain of misses) {
    const company = companyFromEntry_(stored[CE_COMPANY_PREFIX + domain], domain);
    if (company) fromDocument[domain] = company;
  }
  Object.assign(companies, fromDocument);
  putInCache_(fromDocument);
  return { companies, notFound };
}

/**
 * @param {string | undefined} json A cache or property entry.
 * @param {string} domain The domain being looked up.
 * @return {Company | null} The company, only if the entry was saved for this domain.
 */
function companyFromEntry_(json, domain) {
  if (!json) return null;
  try {
    const entry = JSON.parse(json);
    return entry && entry.domain === domain && entry.company ? entry.company : null;
  } catch (error) {
    return null; // unreadable entries count as misses
  }
}

/**
 * Saves freshly fetched companies to both layers.
 * @param {Record<string, Company>} companiesByDomain Keyed by the normalized lookup domain.
 */
function cacheCompanies_(companiesByDomain) {
  /** @type {Record<string, Company>} */
  const compacted = {};
  /** @type {Record<string, string>} */
  const records = {};
  const savedAt = Date.now();
  for (const [domain, company] of Object.entries(companiesByDomain)) {
    compacted[domain] = compactCompany_(company);
    records[CE_COMPANY_PREFIX + domain] = JSON.stringify({ domain, savedAt, company: compacted[domain] });
  }
  if (!Object.keys(records).length) return;
  putInCache_(compacted);
  try {
    setDocumentProperties_(records);
  } catch (error) {
    // Still in CacheService for 6 hours; only the long-term copy is missing.
    console.warn(`Could not save companies to document properties: ${errorMessage_(error)}`);
  }
}

/**
 * @param {string[]} domains
 */
function cacheNotFound_(domains) {
  const cache = CacheService.getDocumentCache();
  if (!cache || !domains.length) return;
  /** @type {Record<string, string>} */
  const entries = {};
  for (const domain of domains) entries[CE_MISSING_PREFIX + domain] = domain;
  cache.putAll(entries, CE_CACHE_SECONDS);
}

/**
 * @param {string[]} domains
 * @return {Set<string>} The domains another execution is fetching right now.
 */
function readInFlight_(domains) {
  const cache = CacheService.getDocumentCache();
  if (!cache || !domains.length) return new Set();
  const marked = cache.getAll(domains.map((domain) => CE_INFLIGHT_PREFIX + domain));
  return new Set(domains.filter((domain) => marked[CE_INFLIGHT_PREFIX + domain]));
}

/**
 * @param {string[]} domains
 */
function markInFlight_(domains) {
  const cache = CacheService.getDocumentCache();
  if (!cache || !domains.length) return;
  /** @type {Record<string, string>} */
  const entries = {};
  for (const domain of domains) entries[CE_INFLIGHT_PREFIX + domain] = '1';
  cache.putAll(entries, CE_INFLIGHT_SECONDS);
}

/**
 * @param {string[]} domains
 */
function releaseInFlight_(domains) {
  const cache = CacheService.getDocumentCache();
  if (cache && domains.length) cache.removeAll(domains.map((domain) => CE_INFLIGHT_PREFIX + domain));
}

/**
 * Removes every saved company from document properties and their copies from
 * CacheService. Returns how many companies were removed.
 * @return {number}
 */
function clearCompanyCache_() {
  const properties = PropertiesService.getDocumentProperties();
  const keys = properties.getKeys().filter((key) => key.startsWith(CE_COMPANY_PREFIX));
  for (const key of keys) properties.deleteProperty(key);
  const cache = CacheService.getDocumentCache();
  if (cache && keys.length) cache.removeAll(keys);
  return keys.length;
}

/**
 * @param {Record<string, Company>} companiesByDomain
 */
function putInCache_(companiesByDomain) {
  const cache = CacheService.getDocumentCache();
  if (!cache) return;
  /** @type {Record<string, string>} */
  const entries = {};
  for (const [domain, company] of Object.entries(companiesByDomain)) {
    entries[CE_COMPANY_PREFIX + domain] = JSON.stringify({ domain, company });
  }
  if (Object.keys(entries).length) cache.putAll(entries, CE_CACHE_SECONDS);
}

/**
 * Writes document properties. If the 500 KB store is full, drops the oldest
 * quarter of saved companies and tries once more; a second failure throws.
 * @param {Record<string, string>} records
 */
function setDocumentProperties_(records) {
  const properties = PropertiesService.getDocumentProperties();
  try {
    properties.setProperties(records);
  } catch (error) {
    evictOldestCompanies_(properties);
    properties.setProperties(records);
  }
}

/**
 * @param {GoogleAppsScript.Properties.Properties} properties
 */
function evictOldestCompanies_(properties) {
  const saved = Object.entries(properties.getProperties())
    .filter(([key]) => key.startsWith(CE_COMPANY_PREFIX))
    .map(([key, json]) => ({ key, savedAt: savedAtOf_(json) }))
    .sort((a, b) => a.savedAt - b.savedAt);
  for (const entry of saved.slice(0, Math.ceil(saved.length / 4))) properties.deleteProperty(entry.key);
}

/**
 * @param {string} json
 * @return {number} When the entry was saved; 0 (evicted first) if unreadable.
 */
function savedAtOf_(json) {
  try {
    return Number(JSON.parse(json).savedAt) || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Drops empty values so more companies fit in the 500 KB store, and drops the
 * description if a record would still exceed one property's size limit.
 * @param {Company} company
 * @return {Company}
 */
function compactCompany_(company) {
  const compact = /** @type {Company} */ (withoutEmptyValues_(company) || {});
  if (utf8Bytes_(JSON.stringify(compact)) > CE_MAX_PROPERTY_BYTES) delete compact.description;
  return compact;
}

/**
 * @param {string} text
 * @return {number} Size in UTF-8 bytes: each %XX escape is one byte.
 */
function utf8Bytes_(text) {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, '_').length;
}

/**
 * @param {unknown} value
 * @return {unknown} The value without null, '' and [] entries, or undefined if nothing is left.
 */
function withoutEmptyValues_(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value)) return value.length ? value : undefined;
  if (typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = withoutEmptyValues_(child);
    if (kept !== undefined) result[key] = kept;
  }
  return Object.keys(result).length ? result : undefined;
}
