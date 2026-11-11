/**
 * Field paths: what someone types in a formula ("Country", "employees",
 * "location.city.name") and how a value is read out of a company record.
 */

/**
 * Resolves a typed field name to a path from CE_FIELDS. Throws for unknown
 * fields before any API call, so a typo never costs a credit.
 * @param {unknown} field
 * @return {string}
 */
function resolveFieldPath_(field) {
  const typed = cellText_(field).trim();
  if (!typed) throw new Error('Missing field. Try "name", "industry", "employees" or "location.country.name".');
  const key = typed.toLowerCase();

  const aliases = /** @type {Record<string, string>} */ (CE_FIELD_ALIASES);
  if (aliases[key]) return aliases[key];

  const known = CE_FIELDS.find((candidate) => candidate.path.toLowerCase() === key);
  if (known) return known.path;

  const root = key.split('.')[0];
  if (CE_EXPANSION_FIELDS.some((name) => name.toLowerCase() === root)) {
    throw new Error(`"${typed}" is only returned with a paid expansion, which these formulas never request.`);
  }
  const children = CE_FIELDS.filter((candidate) => candidate.path.toLowerCase().startsWith(key + '.'));
  if (children.length) {
    throw new Error(`"${typed}" is a group of fields. Pick one: ${children.map((child) => child.path).join(', ')}.`);
  }
  throw new Error(
    `Unknown field "${typed}". Try name, domain, industry, employees, revenue, foundedYear, country, city or linkedin.`,
  );
}

/**
 * @param {string} path
 * @return {string}
 */
function fieldLabel_(path) {
  const field = CE_FIELDS.find((candidate) => candidate.path === path);
  return field ? field.label : path;
}

/**
 * Follows a dotted path through nested objects. Missing steps give undefined.
 * @param {unknown} source
 * @param {string} path
 * @return {unknown}
 */
function valueAt_(source, path) {
  /** @type {any} */
  let value = source;
  for (const part of path.split('.')) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Converts an API value to something a cell can hold: lists become
 * "a, b, c", missing values become an empty cell.
 * @param {unknown} value
 * @return {string | number | boolean}
 */
function toCellValue_(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return /** @type {string | number | boolean} */ (value);
}

/**
 * @param {Company} company
 * @param {string} path
 * @return {string | number | boolean}
 */
function readField_(company, path) {
  return toCellValue_(valueAt_(company, path));
}
