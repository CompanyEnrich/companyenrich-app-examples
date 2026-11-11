/**
 * Looks up companies by domain while spending as little as possible:
 *
 * 1. Read both cache layers.
 * 2. Under the document lock, read the cache again and claim the remaining
 *    domains (an in-flight marker plus a credit reservation). Sheets runs many
 *    cells at once; a domain another cell has claimed is waited for, never
 *    bought twice.
 * 3. Fetch the claimed domains: one GET /v2/companies/enrich for a single
 *    domain, or POST /v2/companies/enrich/batch with 50 per call. No new call
 *    starts once the time budget is used up; the rest are "deferred".
 */

/**
 * @typedef {object} LookupOptions
 * @property {boolean} waitForEnrichment False keeps calls fast for custom
 *   functions: companies CompanyEnrich has not stored yet come back "pending"
 *   and are enriched in the background, instead of being enriched on demand.
 * @property {number} [maxCredits] Refuse to call the API if the new domains
 *   could cost more than this.
 * @property {number} [timeBudgetMs] How long to keep starting paid calls.
 *   Defaults to the custom function budget.
 */

/**
 * @param {unknown[]} cells Raw cell values; blanks and duplicates are fine.
 * @param {LookupOptions} options
 * @return {{results: Record<string, LookupResult>, billed: number}} Results by
 *   normalized domain, and the credits this call spent.
 */
function lookupCompanies_(cells, options) {
  const deadline = Date.now() + (options.timeBudgetMs || CE_FORMULA_TIME_BUDGET_MS);
  const { domains, invalid } = uniqueDomains_(cells);
  /** @type {Record<string, LookupResult>} */
  const results = {};
  for (const domain of invalid) results[domain] = { status: 'invalid-domain' };

  applyCached_(domains, results);
  const misses = domains.filter((domain) => !results[domain]);
  if (!misses.length) return { results, billed: 0 };
  if (options.maxCredits !== undefined && misses.length * CE_COST.enrich > options.maxCredits) {
    throw new Error(
      `This needs up to ${misses.length * CE_COST.enrich} credits, more than the ${options.maxCredits} you confirmed.`,
    );
  }

  const { claimed, claimedElsewhere, reservation } = claimDomains_(misses, results);
  const billed = fetchClaimed_(claimed, reservation, options, results, deadline);
  waitForOtherCells_(claimedElsewhere, results, deadline);
  return { results, billed };
}

/**
 * Copies cached answers for `domains` into `results`.
 * @param {string[]} domains
 * @param {Record<string, LookupResult>} results
 */
function applyCached_(domains, results) {
  const { companies, notFound } = readCache_(domains);
  for (const [domain, company] of Object.entries(companies)) results[domain] = { status: 'found', company };
  for (const domain of notFound) results[domain] = { status: 'not-found' };
}

/**
 * Atomically decides which cell pays for each missing domain: under the
 * document lock, re-read the cache (another cell may have just saved it),
 * skip domains another cell is fetching, then reserve credits and mark the
 * rest in flight.
 * @param {string[]} misses
 * @param {Record<string, LookupResult>} results
 * @return {{claimed: string[], claimedElsewhere: string[], reservation: Reservation}}
 */
function claimDomains_(misses, results) {
  return withDocumentLock_(() => {
    applyCached_(misses, results);
    const open = misses.filter((domain) => !results[domain]);
    const busy = readInFlight_(open);
    const claimed = open.filter((domain) => !busy.has(domain));
    const reservation = reserveCreditsLocked_(claimed.length * CE_COST.enrich);
    markInFlight_(claimed);
    return { claimed, claimedElsewhere: open.filter((domain) => busy.has(domain)), reservation };
  });
}

/**
 * Fetches claimed domains chunk by chunk. Each chunk is cached and released
 * as soon as it is paid for; on failure the unfetched claims are released
 * and the reservation is settled to what may have been charged.
 * @param {string[]} claimed
 * @param {Reservation} reservation The credits reserved for `claimed`.
 * @param {LookupOptions} options
 * @param {Record<string, LookupResult>} results
 * @param {number} deadline
 * @return {number} Credits billed.
 */
function fetchClaimed_(claimed, reservation, options, results, deadline) {
  let billed = 0;
  let next = 0; // index of the first claimed domain not fetched yet
  try {
    while (next < claimed.length && Date.now() < deadline) {
      const chunk = claimed.slice(next, next + CE_BATCH_SIZE);
      const fetched = claimed.length === 1 ? enrichOne_(chunk[0], options) : enrichBatch_(chunk, options);
      billed += saveFetched_(fetched, results);
      next += chunk.length;
      releaseInFlight_(chunk);
    }
  } catch (error) {
    const failedChunk = Math.min(CE_BATCH_SIZE, claimed.length - next);
    releaseInFlight_(claimed.slice(next));
    settleCredits_(reservation, billed + chargeAfterFailure_(error, failedChunk * CE_COST.enrich));
    throw error;
  }
  // Out of time: leave the rest for a recalculation or the sidebar.
  const skipped = claimed.slice(next);
  for (const domain of skipped) results[domain] = { status: 'deferred' };
  releaseInFlight_(skipped);
  settleCredits_(reservation, billed);
  return billed;
}

/**
 * Waits, within the time budget, for domains another cell is fetching to
 * appear in the cache. Whatever does not arrive in time shows as pending.
 * @param {string[]} domains
 * @param {Record<string, LookupResult>} results
 * @param {number} deadline
 */
function waitForOtherCells_(domains, results, deadline) {
  let waiting = domains;
  while (waiting.length && Date.now() + CE_POLL_MS < deadline) {
    Utilities.sleep(CE_POLL_MS);
    applyCached_(waiting, results);
    const stillBusy = readInFlight_(waiting.filter((domain) => !results[domain]));
    waiting = waiting.filter((domain) => stillBusy.has(domain));
  }
  for (const domain of domains) if (!results[domain]) results[domain] = { status: 'pending' };
}

/**
 * Copies fetched results into `results`, caches them, and returns the credits
 * they cost: the API bills once per unique company, even if two domains lead to it.
 * @param {Record<string, LookupResult>} fetched
 * @param {Record<string, LookupResult>} results
 * @return {number}
 */
function saveFetched_(fetched, results) {
  /** @type {Record<string, Company>} */
  const found = {};
  /** @type {string[]} */
  const missing = [];
  for (const [domain, result] of Object.entries(fetched)) {
    results[domain] = result;
    if (result.status === 'found') found[domain] = result.company;
    if (result.status === 'not-found') missing.push(domain);
  }
  cacheCompanies_(found);
  cacheNotFound_(missing);
  return new Set(Object.values(found).map((company) => company.id)).size * CE_COST.enrich;
}

/**
 * @param {string} domain
 * @param {LookupOptions} options
 * @return {Record<string, LookupResult>}
 */
function enrichOne_(domain, options) {
  const company = ceEnrich_(domain, options.waitForEnrichment);
  return { [domain]: company ? { status: 'found', company } : { status: 'not-found' } };
}

/**
 * @param {string[]} domains At most 50.
 * @param {LookupOptions} options
 * @return {Record<string, LookupResult>}
 */
function enrichBatch_(domains, options) {
  const items = ceEnrichBatch_(domains, options.waitForEnrichment);
  const byDomain = new Map(items.map((item) => [item.domain, item]));
  /** @type {Record<string, LookupResult>} */
  const results = {};
  for (const domain of domains) {
    const item = byDomain.get(domain);
    // A domain missing from the response is treated as pending: not cached, retried next time.
    if (!item) results[domain] = { status: 'pending' };
    else if (item.status === 'found' && item.company) results[domain] = { status: 'found', company: item.company };
    else if (item.status === 'pending' || item.status === 'invalid-domain') results[domain] = { status: item.status };
    else results[domain] = { status: 'not-found' };
  }
  return results;
}

/**
 * The values to write for one domain cell: the requested fields when the
 * company was found, otherwise the reason in the first column.
 * @param {Record<string, LookupResult>} results From lookupCompanies_.
 * @param {unknown} cell The raw cell value.
 * @param {string[]} paths
 * @return {Array<string | number | boolean>}
 */
function rowValues_(results, cell, paths) {
  const domain = normalizeDomain_(cell);
  if (!domain) return paths.map(() => '');
  const result = results[domain];
  if (result && result.status === 'found') return paths.map((path) => readField_(result.company, path));
  return paths.map((_, index) => (index === 0 ? missText_(result) : ''));
}

/**
 * What a cell shows for a domain without a company.
 * @param {LookupResult | undefined} result
 * @return {string}
 */
function missText_(result) {
  if (!result || result.status === 'not-found') return CE_TEXT.notFound;
  if (result.status === 'pending') return CE_TEXT.pending;
  if (result.status === 'deferred') return CE_TEXT.deferred;
  return CE_TEXT.invalidDomain;
}
