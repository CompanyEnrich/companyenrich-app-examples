/**
 * A small CompanyEnrich v2 client built on UrlFetchApp.
 *
 * The official JavaScript SDK needs fetch and Promises, which Apps Script does
 * not have, so this file mirrors what the SDK sends: the same endpoints and
 * request bodies and Bearer authentication. Retries are stricter than the
 * SDK's defaults: a 429 is always retried (nothing was processed), but a 5xx
 * is retried only on free endpoints, because a paid call, GET or POST, may
 * already have been charged.
 */

/**
 * @typedef {object} CallOptions
 * @property {Record<string, string | number | boolean>} [query]
 * @property {unknown} [body] JSON request body.
 * @property {boolean} [free] True for endpoints that never charge credits.
 * @property {string} [apiKey] Overrides the saved key, for checking a new key.
 */

/**
 * The key comes from user properties, never from the spreadsheet. Inside a
 * custom function Apps Script returns the spreadsheet owner's properties, so
 * formulas always spend the owner's key, while the menu and sidebar use the
 * key of whoever runs them. Editors can change this script and so could read
 * the owner's key: only share edit access with people trusted with it.
 * @return {string}
 */
function getApiKey_() {
  const key = PropertiesService.getUserProperties().getProperty(CE_KEY_PROPERTY);
  if (!key) throw new Error('No CompanyEnrich API key. Use the CompanyEnrich menu > Set API key.');
  return key;
}

/**
 * @param {'get' | 'post'} method
 * @param {string} path Path below /v2, for example "/companies/enrich".
 * @param {CallOptions} options
 * @return {GoogleAppsScript.URL_Fetch.URLFetchRequest}
 */
function buildRequest_(method, path, options) {
  const query = Object.entries(options.query || {})
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join('&');
  /** @type {GoogleAppsScript.URL_Fetch.URLFetchRequest} */
  const request = {
    url: CE_API_BASE + path + (query ? `?${query}` : ''),
    method,
    headers: { Authorization: `Bearer ${options.apiKey || getApiKey_()}`, Accept: 'application/json' },
    muteHttpExceptions: true, // read 4xx/5xx bodies instead of getting a generic exception
  };
  if (options.body !== undefined) {
    request.contentType = 'application/json';
    request.payload = JSON.stringify(options.body);
  }
  return request;
}

/**
 * Sends one request, retrying rate limits, and server errors on free endpoints.
 * @param {'get' | 'post'} method
 * @param {string} path
 * @param {CallOptions} [options]
 * @return {any} The parsed JSON response.
 */
function ceRequest_(method, path, options = {}) {
  const request = buildRequest_(method, path, options);
  const canRetryServerErrors = Boolean(options.free);
  for (let attempt = 0; ; attempt++) {
    const response = fetchOrThrow_(request);
    const status = response.getResponseCode();
    if (status >= 200 && status < 300) return parseJson_(response);
    const retryable = status === 429 || (status >= 500 && canRetryServerErrors);
    if (!retryable || attempt >= CE_MAX_RETRIES) throw apiError_(status, response);
    Utilities.sleep(retryDelayMs_(response, attempt));
  }
}

/**
 * Runs free POST calls in parallel with UrlFetchApp.fetchAll, a few at a time.
 * Rate-limited or failed calls are sent again through ceRequest_'s retries.
 * @param {Array<{path: string, body: unknown}>} calls
 * @return {any[]} Parsed responses, in the order of `calls`.
 */
function cePostAllFree_(calls) {
  /** @type {any[]} */
  const results = [];
  for (let start = 0; start < calls.length; start += CE_PARALLEL_REQUESTS) {
    const group = calls.slice(start, start + CE_PARALLEL_REQUESTS);
    const requests = group.map((call) => buildRequest_('post', call.path, { body: call.body, free: true }));
    /** @type {GoogleAppsScript.URL_Fetch.HTTPResponse[]} */
    let responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (error) {
      throw new Error(`Could not reach CompanyEnrich: ${errorMessage_(error)}`);
    }
    responses.forEach((response, index) => {
      const status = response.getResponseCode();
      const call = group[index];
      if (status >= 200 && status < 300) results.push(parseJson_(response));
      else if (status === 429 || status >= 500) results.push(ceRequest_('post', call.path, { body: call.body, free: true }));
      else throw apiError_(status, response);
    });
  }
  return results;
}

/**
 * UrlFetchApp throws its own exception for DNS failures and timeouts.
 * @param {GoogleAppsScript.URL_Fetch.URLFetchRequest} request
 * @return {GoogleAppsScript.URL_Fetch.HTTPResponse}
 */
function fetchOrThrow_(request) {
  try {
    return UrlFetchApp.fetch(request.url, request);
  } catch (error) {
    throw new Error(`Could not reach CompanyEnrich: ${errorMessage_(error)}`);
  }
}

/**
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @return {any}
 */
function parseJson_(response) {
  try {
    return JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(`CompanyEnrich sent a response that is not JSON (HTTP ${response.getResponseCode()}).`);
  }
}

/**
 * Waits as long as the API asks (Retry-After in seconds, or the time left in
 * the rate-limit window, "00:00:12.5"), capped at 8 seconds so a custom
 * function stays inside its 30-second limit. Otherwise backs off 1s, then 2s.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @param {number} attempt
 * @return {number}
 */
function retryDelayMs_(response, attempt) {
  const headers = /** @type {Record<string, string>} */ (response.getHeaders());
  /** @param {string} wanted */
  const header = (wanted) => {
    const name = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
    return name ? String(headers[name]) : '';
  };
  const retryAfter = Number(header('retry-after'));
  const span = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(header('x-ratelimit-window'));
  const windowLeft = span ? Number(span[1]) * 3600 + Number(span[2]) * 60 + Number(span[3]) : 0;
  const seconds = retryAfter > 0 ? retryAfter : windowLeft;
  return seconds > 0 ? Math.min(seconds, 8) * 1000 : 1000 * 2 ** attempt;
}

/**
 * Builds a one-line, actionable error. `status` is kept on the error so
 * callers can treat 404 as "not found" instead of a failure.
 * @param {number} status
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} response
 * @return {Error & {status: number}}
 */
function apiError_(status, response) {
  /** @type {{detail?: string, title?: string, errors?: Record<string, string[]>}} */
  let problem = {};
  try {
    problem = JSON.parse(response.getContentText()) || {};
  } catch (error) {
    // Not a problem+json body; the status alone decides the message.
  }
  return Object.assign(new Error(describeApiError_(status, problem)), { status });
}

/**
 * @param {number} status
 * @param {{detail?: string, title?: string, errors?: Record<string, string[]>}} problem
 * @return {string}
 */
function describeApiError_(status, problem) {
  switch (status) {
    case 401:
      return 'CompanyEnrich rejected the API key (401). Set a valid key with CompanyEnrich > Set API key.';
    case 402:
      return 'Not enough CompanyEnrich credits (402). Top up at https://companyenrich.com/dashboard.';
    case 403:
      return 'Your CompanyEnrich plan does not include this feature (403).';
    case 404:
      return 'Not found (404).';
    case 429:
      return 'CompanyEnrich rate limit reached (429). Wait a minute and try again.';
    case 400:
    case 422: {
      const fields = Object.entries(problem.errors || {}).map(([field, messages]) => `${field}: ${messages.join(' ')}`);
      const detail = [problem.detail || problem.title, ...fields].filter(Boolean).join(' ');
      return `CompanyEnrich rejected the request (${status}). ${detail}`.trim();
    }
    default:
      return status >= 500
        ? `CompanyEnrich is having trouble (HTTP ${status}). Try again shortly.`
        : `CompanyEnrich request failed (HTTP ${status}). ${problem.detail || ''}`.trim();
  }
}

/**
 * @param {unknown} error
 * @return {number} The HTTP status attached by apiError_, or 0.
 */
function statusOf_(error) {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : 0;
  return typeof status === 'number' ? status : 0;
}

// Endpoint wrappers, named after the SDK methods they mirror.

/**
 * me(): credit balance and plan capabilities. Free.
 * @param {string} [apiKey] Check a key before saving it.
 */
function ceMe_(apiKey) {
  return ceRequest_('get', '/me', { apiKey, free: true });
}

/**
 * companies.enrich(): 1 credit when found. Returns null when there is no such company.
 * @param {string} domain
 * @param {boolean} waitForEnrichment False returns at once for companies not stored yet.
 * @return {Company | null}
 */
function ceEnrich_(domain, waitForEnrichment) {
  try {
    return ceRequest_('get', '/companies/enrich', { query: { domain, waitForEnrichment } });
  } catch (error) {
    if (statusOf_(error) === 404) return null;
    throw error;
  }
}

/**
 * companies.enrichBatch(): up to 50 domains, 1 credit per company found.
 * @param {string[]} domains
 * @param {boolean} waitForEnrichment
 * @return {Array<{domain: string, status: string, company?: Company}>}
 */
function ceEnrichBatch_(domains, waitForEnrichment) {
  return ceRequest_('post', '/companies/enrich/batch', { body: { domains, waitForEnrichment } }).items;
}

/**
 * companies.count(): free.
 * @param {object} query The same shape as a company search, without paging.
 * @return {{count: number, total: number}}
 */
function ceCountCompanies_(query) {
  return ceRequest_('post', '/companies/search/count', { body: query, free: true });
}

/**
 * companies.search(): 1, 2 or 5 credits per company (filter, semantic, lookalike).
 * @param {object} query
 * @return {{items: Company[], scores?: Record<string, number>}}
 */
function ceSearchCompanies_(query) {
  return ceRequest_('post', '/companies/search', { body: query });
}

/**
 * people.search(): 2 credits per person.
 * @param {object} query
 * @return {{items: Array<Record<string, any>>}}
 */
function ceSearchPeople_(query) {
  return ceRequest_('post', '/people/search', { body: query });
}

/**
 * geo.searchCountries(): free.
 * @param {string} name
 * @return {Array<{code: string, name: string}>}
 */
function ceSearchCountries_(name) {
  return ceRequest_('post', '/geo/countries', { body: { query: name, pageSize: 10 }, free: true }).items;
}
