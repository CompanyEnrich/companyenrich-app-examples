/**
 * Turning cell values into clean API inputs: domains, lists and enum values.
 * Everything here runs before any API call, so bad input never costs a credit.
 */

/**
 * Custom functions receive a plain value for one cell and a 2D array for a range.
 * @param {unknown} arg
 * @return {unknown[][]}
 */
function toGrid_(arg) {
  return Array.isArray(arg) ? arg : [[arg]];
}

/**
 * Splits "a, b", or a range of cells that may themselves hold "a, b", into a list.
 * @param {unknown} arg
 * @return {string[]}
 */
function toList_(arg) {
  return toGrid_(arg)
    .flat()
    .flatMap((cell) => cellText_(cell).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown} cell
 * @return {string}
 */
function cellText_(cell) {
  return cell === null || cell === undefined ? '' : String(cell);
}

/**
 * Reduces what people paste into a cell to a bare domain:
 * "https://www.Stripe.com/pricing" becomes "stripe.com", and an email address
 * keeps its domain. Returns '' for an empty cell.
 * @param {unknown} cell
 * @return {string}
 */
function normalizeDomain_(cell) {
  const host = cellText_(cell)
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
    .split(/[/?#]/)[0]; // path, query, fragment
  return host
    .slice(host.lastIndexOf('@') + 1) // email address or user@ prefix
    .replace(/:\d+$/, '') // port
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * True for letters, digits and hyphens in two or more dot-separated labels.
 * Real company domains are far below the 240-character cap, which keeps cache
 * keys under CacheService's 250-character limit.
 * @param {string} domain
 * @return {boolean}
 */
function isDomain_(domain) {
  return domain.length <= 240 && /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/.test(domain);
}

/**
 * Normalizes a list of cells into unique valid domains, in first-seen order.
 * @param {unknown[]} cells
 * @return {{domains: string[], invalid: string[]}}
 */
function uniqueDomains_(cells) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const domains = [];
  /** @type {string[]} */
  const invalid = [];
  for (const cell of cells) {
    const domain = normalizeDomain_(cell);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    (isDomain_(domain) ? domains : invalid).push(domain);
  }
  return { domains, invalid };
}

/**
 * Matches what someone typed against an API enum, ignoring case, so "1k-5k"
 * becomes "1K-5K".
 * @param {ReadonlyArray<string>} allowed
 * @param {string} label What the value is, for the error message.
 * @param {string} typed
 * @return {string}
 */
function matchEnum_(allowed, label, typed) {
  const match = allowed.find((value) => value.toLowerCase() === typed.toLowerCase());
  if (!match) throw new Error(`Unknown ${label} "${typed}". Use one of: ${allowed.join(', ')}.`);
  return match;
}

/**
 * Turns "US", "Germany" or "united kingdom" into ISO country codes. Two-letter
 * values are used as codes; names are looked up with the free geo search.
 * @param {string[]} names
 * @return {string[]}
 */
function resolveCountries_(names) {
  return names.map((name) => {
    if (/^[a-z]{2}$/i.test(name)) return name.toUpperCase();
    const matches = ceSearchCountries_(name);
    const exact = matches.find((country) => country.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact.code;
    if (matches.length === 1) return matches[0].code;
    if (!matches.length) throw new Error(`Unknown country "${name}". Use a two-letter code such as "US" or "DE".`);
    const options = matches.slice(0, 5).map((country) => `${country.name} (${country.code})`);
    throw new Error(`"${name}" matches several countries: ${options.join(', ')}. Use the two-letter code.`);
  });
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {string} label
 * @return {number}
 */
function toWholeNumber_(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

/**
 * Error messages for cells and the sidebar. Errors can come from other realms
 * (for example service exceptions), so this checks the shape, not instanceof.
 * @param {unknown} error
 * @return {string}
 */
function errorMessage_(error) {
  const message = error && typeof error === 'object' && 'message' in error ? error.message : error;
  return String(message);
}
