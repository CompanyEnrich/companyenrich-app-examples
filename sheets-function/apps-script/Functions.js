/**
 * Custom functions. Sheets decides when to recalculate these (when an argument
 * or the formula changes, and sometimes when the file is reopened), so they
 * only do cheap, safe things: one credit per new domain, cached so a
 * recalculation never bills again and counted against the daily credit cap,
 * plus a free count. Each call must finish within 30 seconds.
 */

/**
 * Returns one field of a company, looked up by domain. Costs 1 CompanyEnrich
 * credit per new domain; repeated lookups come from the cache for free.
 *
 * @param {string|Array<Array<string>>} domain A domain such as "stripe.com", or a column of domains.
 * @param {string} field A field such as "name", "industry", "employees" or "location.country.name".
 * @return The value, or a column of values when given a range.
 * @customfunction
 */
function COMPANYENRICH(domain, field) {
  const path = resolveFieldPath_(field);
  const grid = toGrid_(domain);
  const { results } = lookupCompanies_(grid.flat(), { waitForEnrichment: !Array.isArray(domain) });
  const values = grid.map((row) => row.map((cell) => rowValues_(results, cell, [path])[0]));
  return Array.isArray(domain) ? values : values[0][0];
}

/**
 * Returns several fields of a company as a row. Costs 1 CompanyEnrich credit
 * per new domain; repeated lookups come from the cache for free.
 *
 * @param {string|Array<Array<string>>} domain A domain, or a single column of domains (one row each).
 * @param {string|Array<Array<string>>} fields Comma-separated fields such as "name,industry,employees", or a range of field names.
 * @return One row of values per domain.
 * @customfunction
 */
function COMPANYENRICH_ROW(domain, fields) {
  const paths = toList_(fields).map(resolveFieldPath_);
  if (!paths.length) throw new Error('List the fields to return, for example "name,industry,employees".');
  const grid = toGrid_(domain);
  if (grid.some((row) => row.length !== 1)) {
    throw new Error('COMPANYENRICH_ROW takes one domain or a single column of domains.');
  }
  const cells = grid.map((row) => row[0]);
  const { results } = lookupCompanies_(cells, { waitForEnrichment: !Array.isArray(domain) });
  return cells.map((cell) => rowValues_(results, cell, paths));
}

/**
 * Counts companies matching a country, employee range and category. Free: no
 * credits are used. Leave an argument empty to skip that filter.
 *
 * @param {string} country A country code or name, such as "US" or "Germany". Comma-separate several.
 * @param {string} employees An employee range: 1-10, 11-50, 51-200, 201-500, 501-1K, 1K-5K, 5K-10K or over-10K. Comma-separate several.
 * @param {string} categories A category such as "saas" or "b2b". Several must all match.
 * @return The number of matching companies.
 * @customfunction
 */
function COMPANYENRICH_COUNT(country, employees, categories) {
  /** @type {Record<string, string[]>} */
  const filter = {};
  const ranges = toList_(employees).map((value) => matchEnum_(CE_EMPLOYEE_RANGES, 'employee range', value));
  const types = toList_(categories).map((value) => matchEnum_(CE_CATEGORIES, 'category', value));
  const countries = resolveCountries_(toList_(country));
  if (countries.length) filter.country = countries;
  if (ranges.length) filter.employees = ranges;
  if (types.length) filter.categories = types;
  // `total` is the full population; `count` is capped at the plan's search limit.
  return ceCountCompanies_(Object.keys(filter).length ? { filter } : {}).total;
}
