/**
 * Server side of Sidebar.html. Functions without a trailing underscore are
 * callable from the sidebar through google.script.run.
 *
 * Every paid action has two steps: an estimate that only uses free calls
 * (cache reads, counts, the balance) and a run. The run does not trust the
 * plan the browser sends back: it requires `confirmed: true`, validates every
 * value against the same rules and limits as the estimate, rebuilds the API
 * query itself (never with paid expansions), recomputes the cost, and refuses
 * to spend more than the amount the user confirmed or today's credit cap.
 */

const CE_LOOKALIKE_COLUMNS = Object.freeze([
  'name', 'domain', 'industry', 'employees', 'location.country.name', 'socials.linkedinUrl',
]);
const CE_PEOPLE_HEADER = Object.freeze([
  'Name', 'Title', 'Seniority', 'Department', 'Company', 'Domain', 'Country', 'LinkedIn',
]);
const CE_MAX_SHEET_ROWS = 100000; // bounds for row and column numbers sent back by the sidebar
const CE_MAX_SHEET_COLUMNS = 18278;

/** What the sidebar needs to draw itself, plus the current balance. */
function getSidebarState() {
  const hasKey = Boolean(PropertiesService.getUserProperties().getProperty(CE_KEY_PROPERTY));
  /** @type {number | null} */
  let balance = null;
  let balanceError = '';
  if (hasKey) {
    try {
      balance = remainingCredits_(ceMe_());
    } catch (error) {
      balanceError = errorMessage_(error);
    }
  }
  return {
    hasKey,
    balance,
    balanceError,
    budget: readBudget_(),
    fields: CE_FIELDS,
    seniorities: CE_SENIORITIES,
    departments: CE_DEPARTMENTS,
    costs: CE_COST,
    limits: {
      lookalikes: CE_MAX_LOOKALIKES,
      peopleDomains: CE_MAX_PEOPLE_DOMAINS,
      peoplePerCompany: CE_MAX_PEOPLE_PER_COMPANY,
    },
  };
}

/**
 * What an estimate is checked against before the sidebar offers to run it:
 * the account balance (free /v2/me call) and what is left of today's cap.
 * @return {{balance: number, capLeft: number}}
 */
function spendingRoom_() {
  const { cap, spent } = readBudget_();
  return { balance: remainingCredits_(ceMe_()), capLeft: Math.max(0, cap - spent) };
}

// Enrich selected column

/**
 * Step 1 (free): what would it cost to enrich the selected column?
 * The returned job goes back to enrichSelectionChunk once confirmed.
 * @param {string[]} fields Field paths picked in the sidebar.
 */
function estimateEnrichSelection(fields) {
  const paths = toFieldPaths_(fields);
  const selection = readSelection_();
  const { domains, invalid } = uniqueDomains_(selection.cells);
  if (!domains.length) throw new Error('No domains found in the selection.');
  const { companies, notFound } = readCache_(domains);
  const cached = Object.keys(companies).length + notFound.length;
  return {
    sheetName: selection.sheetName,
    rangeA1: selection.rangeA1,
    column: selection.column,
    headerRow: selection.headerRow,
    firstRow: selection.firstRow,
    rowCount: selection.cells.length,
    fields: paths,
    domains: domains.length,
    cached,
    invalid: invalid.length,
    maxCredits: (domains.length - cached) * CE_COST.enrich,
    ...spendingRoom_(),
    confirmed: false,
    // Progress, updated by enrichSelectionChunk:
    targetColumn: 0,
    offset: 0,
    billed: 0,
    done: false,
  };
}

/**
 * Step 2 (paid): enriches the next 50 rows of a confirmed job and writes them
 * to new columns right of the domains. The sidebar calls this until `done`,
 * which keeps every call far below the 6-minute script limit and shows progress.
 * The cost is recomputed from the cache for every chunk.
 * @param {ReturnType<typeof estimateEnrichSelection>} job
 */
function enrichSelectionChunk(job) {
  requireConfirmed_(job);
  const fields = toFieldPaths_(job.fields);
  const column = toWholeNumber_(job.column, 1, CE_MAX_SHEET_COLUMNS, 'Column');
  const headerRow = toWholeNumber_(job.headerRow, 0, CE_MAX_SHEET_ROWS, 'Header row');
  const firstRow = toWholeNumber_(job.firstRow, 1, CE_MAX_SHEET_ROWS, 'First row');
  const rowCount = toWholeNumber_(job.rowCount, 0, CE_MAX_SHEET_ROWS, 'Row count');
  const offset = toWholeNumber_(job.offset, 0, rowCount, 'Progress');
  const billedSoFar = toWholeNumber_(job.billed, 0, CE_MAX_SHEET_ROWS, 'Credits spent');
  const confirmedCredits = toWholeNumber_(job.maxCredits, 0, CE_MAX_SHEET_ROWS, 'Confirmed credits');
  let targetColumn = toWholeNumber_(job.targetColumn, 0, CE_MAX_SHEET_COLUMNS, 'Target column');
  if (offset >= rowCount) return { ...job, done: true };

  const sheet = sheetByName_(String(job.sheetName));
  if (!targetColumn) {
    sheet.insertColumnsAfter(column, fields.length);
    targetColumn = column + 1;
    if (headerRow) {
      sheet.getRange(headerRow, targetColumn, 1, fields.length).setValues([fields.map(fieldLabel_)]).setFontWeight('bold');
    }
  }
  const startRow = firstRow + offset;
  const chunkRows = Math.min(CE_BATCH_SIZE, rowCount - offset);
  const cells = sheet.getRange(startRow, column, chunkRows, 1).getValues().map((row) => row[0]);
  const { results, billed } = lookupCompanies_(cells, {
    waitForEnrichment: true,
    maxCredits: confirmedCredits - billedSoFar,
    timeBudgetMs: CE_SIDEBAR_TIME_BUDGET_MS,
  });
  sheet.getRange(startRow, targetColumn, chunkRows, fields.length).setValues(cells.map((cell) => rowValues_(results, cell, fields)));
  const nextOffset = offset + chunkRows;
  return { ...job, fields, targetColumn, offset: nextOffset, billed: billedSoFar + billed, done: nextOffset >= rowCount };
}

// Find lookalikes for the selected domain

/**
 * Step 1 (free): counts lookalikes of the domain in the current cell.
 * @param {{results: number, country?: string}} options
 */
function estimateLookalikes(options) {
  const domain = activeDomain_();
  const wanted = toWholeNumber_(options.results, 1, CE_MAX_LOOKALIKES, 'Number of lookalikes');
  const countries = resolveCountries_(toList_(options.country));
  const { count } = ceCountCompanies_(lookalikeQuery_(domain, countries));
  const results = Math.min(wanted, count);
  return {
    domain,
    countries,
    available: count,
    results,
    maxCredits: results * CE_COST.lookalike,
    ...spendingRoom_(),
    confirmed: false,
  };
}

/**
 * Step 2 (paid): runs the confirmed search and writes the companies to a new sheet.
 * @param {ReturnType<typeof estimateLookalikes>} plan
 */
function runLookalikes(plan) {
  requireConfirmed_(plan);
  const domain = normalizeDomain_(plan.domain);
  if (!isDomain_(domain)) throw new Error('The plan has no valid domain. Estimate again.');
  const results = toWholeNumber_(plan.results, 1, CE_MAX_LOOKALIKES, 'Number of lookalikes');
  const countries = toCountryCodes_(plan.countries);
  // The query is rebuilt here and never asks for paid expansions, so this is the full cost.
  const reserved = results * CE_COST.lookalike;
  assertWithinBudget_(reserved, plan.maxCredits);
  const reservation = reserveCredits_(reserved);
  /** @type {ReturnType<typeof ceSearchCompanies_>} */
  let page;
  try {
    page = ceSearchCompanies_({ ...lookalikeQuery_(domain, countries), pageSize: results });
  } catch (error) {
    settleCredits_(reservation, chargeAfterFailure_(error, reserved));
    throw error;
  }
  // An empty page still bills one result.
  const credits = Math.max(page.items.length, 1) * CE_COST.lookalike;
  settleCredits_(reservation, credits);

  // These companies are paid for, so later formulas on their domains are free.
  cacheCompanies_(Object.fromEntries(page.items.map((company) => [normalizeDomain_(company.domain), company])));

  const scores = page.scores || {};
  const rows = page.items.map((company, index) => [
    index + 1,
    company.id in scores ? Math.round(scores[company.id] * 1000) / 1000 : '',
    ...CE_LOOKALIKE_COLUMNS.map((path) => readField_(company, path)),
  ]);
  const header = ['Rank', 'Score', ...CE_LOOKALIKE_COLUMNS.map(fieldLabel_)];
  const sheetName = writeSheet_(`Lookalikes - ${domain}`, header, rows);
  return { sheetName, rows: rows.length, credits };
}

/**
 * Lookalikes of one domain, never including the seed company itself.
 * @param {string} domain
 * @param {string[]} countryCodes Empty for anywhere.
 */
function lookalikeQuery_(domain, countryCodes) {
  /** @type {Record<string, unknown>} */
  const filter = { domain: { notIn: [domain] } };
  if (countryCodes.length) filter.country = countryCodes;
  return { lookalike: { domains: [domain] }, filter };
}

// Find people at the selected domains

/**
 * @typedef {object} PeopleOptions
 * @property {string[]} [seniorities]
 * @property {string} [department]
 * @property {string | string[]} [titles] Comma-separated or a list.
 * @property {number} perCompany
 */

/**
 * Step 1 (free): counts matching people at each selected domain, so the
 * estimate is exact and companies with nobody matching are skipped.
 * @param {PeopleOptions} options
 */
function estimatePeople(options) {
  const { domains } = uniqueDomains_(readSelection_().cells);
  if (!domains.length) throw new Error('No domains found in the selection.');
  if (domains.length > CE_MAX_PEOPLE_DOMAINS) {
    throw new Error(`Select at most ${CE_MAX_PEOPLE_DOMAINS} domains at a time (the selection has ${domains.length}).`);
  }
  const people = toPeopleOptions_(options);
  const filter = peopleFilter_(people);
  const counts = cePostAllFree_(
    domains.map((domain) => ({ path: '/people/search/count', body: { filter: { ...filter, domain } } })),
  );
  const companies = domains.map((domain, index) => {
    const available = Number(counts[index].count) || 0;
    return { domain, available, take: Math.min(people.perCompany, available) };
  });
  const total = companies.reduce((sum, company) => sum + company.take, 0);
  return {
    options: people,
    companies,
    people: total,
    maxCredits: total * CE_COST.person,
    ...spendingRoom_(),
    confirmed: false,
  };
}

/**
 * Step 2 (paid): one search per company with matches, written to a new sheet.
 * If a call fails midway, the people already paid for are still written.
 * @param {ReturnType<typeof estimatePeople>} plan
 */
function runPeople(plan) {
  requireConfirmed_(plan);
  const options = toPeopleOptions_(plan.options || {});
  const filter = peopleFilter_(options);
  const targets = toPeopleTargets_(plan.companies, options.perCompany).filter((company) => company.take > 0);
  if (!targets.length) throw new Error('Nobody matches these filters at the selected companies.');
  const reserved = targets.reduce((sum, company) => sum + company.take, 0) * CE_COST.person;
  assertWithinBudget_(reserved, plan.maxCredits);
  const reservation = reserveCredits_(reserved);

  /** @type {Array<Array<string | number | boolean>>} */
  const rows = [];
  let credits = 0;
  let unknownCharge = 0;
  let error = '';
  for (const target of targets) {
    try {
      const page = ceSearchPeople_({ filter: { ...filter, domain: target.domain }, pageSize: target.take });
      credits += Math.max(page.items.length, 1) * CE_COST.person; // an empty page still bills one result
      for (const person of page.items) rows.push(personRow_(person, target.domain));
    } catch (caught) {
      error = errorMessage_(caught);
      unknownCharge = chargeAfterFailure_(caught, target.take * CE_COST.person);
      break;
    }
  }
  settleCredits_(reservation, credits + unknownCharge);
  const sheetName = rows.length ? writeSheet_(`People - ${targets.length} companies`, [...CE_PEOPLE_HEADER], rows) : '';
  return { sheetName, rows: rows.length, credits, error };
}

/**
 * Validates people options from the sidebar into a clean, bounded form.
 * @param {Partial<PeopleOptions>} options
 * @return {{seniorities: string[], department: string, titles: string[], perCompany: number}}
 */
function toPeopleOptions_(options) {
  const seniorities = (Array.isArray(options.seniorities) ? options.seniorities : []).map((value) =>
    matchEnum_(CE_SENIORITIES, 'seniority', String(value)),
  );
  const department = options.department ? matchEnum_(CE_DEPARTMENTS, 'department', String(options.department)) : '';
  const titles = toList_(options.titles);
  if (titles.length > CE_MAX_TITLES || titles.some((title) => title.length > 100)) {
    throw new Error(`Use at most ${CE_MAX_TITLES} title keywords of up to 100 characters each.`);
  }
  const perCompany = toWholeNumber_(options.perCompany, 1, CE_MAX_PEOPLE_PER_COMPANY, 'People per company');
  return { seniorities, department, titles, perCompany };
}

/**
 * @param {ReturnType<typeof toPeopleOptions_>} options
 * @return {Record<string, string | string[]>}
 */
function peopleFilter_(options) {
  /** @type {Record<string, string | string[]>} */
  const filter = {};
  if (options.seniorities.length) filter.seniority = options.seniorities;
  if (options.department) filter.department = options.department;
  if (options.titles.length) filter.position = options.titles;
  return filter;
}

/**
 * Validates the per-company plan sent back by the sidebar.
 * @param {unknown} companies
 * @param {number} perCompany
 * @return {Array<{domain: string, take: number}>}
 */
function toPeopleTargets_(companies, perCompany) {
  if (!Array.isArray(companies) || companies.length > CE_MAX_PEOPLE_DOMAINS) {
    throw new Error(`The plan must list at most ${CE_MAX_PEOPLE_DOMAINS} companies. Estimate again.`);
  }
  /** @type {Set<string>} */
  const seen = new Set();
  return companies.map((company) => {
    const domain = normalizeDomain_(company && company.domain);
    if (!isDomain_(domain) || seen.has(domain)) throw new Error('The plan has an invalid or repeated domain. Estimate again.');
    seen.add(domain);
    return { domain, take: toWholeNumber_(company.take, 0, perCompany, 'People per company') };
  });
}

/**
 * @param {Record<string, any>} person A v2 person.
 * @param {string} domain The domain that was searched.
 * @return {Array<string | number | boolean>}
 */
function personRow_(person, domain) {
  /** @type {Array<Record<string, any>>} */
  const experiences = person.experiences || [];
  const current =
    experiences.find((experience) => experience.isCurrent && valueAt_(experience, 'company.domain') === domain) ||
    experiences.find((experience) => experience.isCurrent) ||
    {};
  return [
    person.name,
    person.position,
    person.seniority,
    person.department,
    valueAt_(current, 'company.name') || current.companyName,
    domain,
    valueAt_(person, 'location.country.name'),
    valueAt_(person, 'socials.linkedinUrl'),
  ].map(toCellValue_);
}

// Shared helpers

/**
 * @param {unknown} plan
 */
function requireConfirmed_(plan) {
  if (!plan || typeof plan !== 'object' || /** @type {{confirmed?: unknown}} */ (plan).confirmed !== true) {
    throw new Error('Confirm the estimate in the sidebar before running it.');
  }
}

/**
 * @param {unknown} fields
 * @return {string[]} Known field paths, at least one.
 */
function toFieldPaths_(fields) {
  const paths = (Array.isArray(fields) ? fields : []).map(resolveFieldPath_);
  if (!paths.length) throw new Error('Pick at least one field.');
  if (paths.length > CE_FIELDS.length) throw new Error('Too many fields.');
  return paths;
}

/**
 * @param {unknown} codes
 * @return {string[]} Two-letter country codes, as resolved by the estimate.
 */
function toCountryCodes_(codes) {
  const list = Array.isArray(codes) ? codes.map(String) : [];
  if (list.length > 20 || list.some((code) => !/^[A-Z]{2}$/.test(code))) {
    throw new Error('The plan has invalid country codes. Estimate again.');
  }
  return list;
}

/**
 * @param {number} cost Recomputed on the server.
 * @param {unknown} confirmed The amount the user confirmed in the sidebar.
 */
function assertWithinBudget_(cost, confirmed) {
  if (typeof confirmed !== 'number' || !Number.isFinite(confirmed) || cost > confirmed) {
    throw new Error(`This would cost ${cost} credits, more than the ${confirmed} you confirmed. Estimate again.`);
  }
}

/**
 * Reads a one-column selection. A first cell that is not a domain (such as
 * "Website") is the header row; otherwise headers go in the row above.
 */
function readSelection_() {
  const range = SpreadsheetApp.getActiveRange();
  if (!range) throw new Error('Select the cells with domains first.');
  if (range.getNumColumns() !== 1) throw new Error('Select a single column of domains.');
  const sheet = range.getSheet();
  const top = range.getRow();
  // A whole-column selection (A:A) stops at the last row with data.
  const rowCount = Math.min(range.getNumRows(), sheet.getLastRow() - top + 1);
  if (rowCount < 1) throw new Error('The selection is empty.');
  const values = sheet.getRange(top, range.getColumn(), rowCount, 1).getValues().map((row) => row[0]);
  const first = normalizeDomain_(values[0]);
  const hasHeader = first !== '' && !isDomain_(first);
  return {
    sheetName: sheet.getName(),
    rangeA1: `${sheet.getName()}!${range.getA1Notation()}`,
    column: range.getColumn(),
    headerRow: hasHeader ? top : top - 1, // 0 means no room for a header
    firstRow: hasHeader ? top + 1 : top,
    cells: hasHeader ? values.slice(1) : values,
  };
}

/** @return {string} The domain in the current cell. */
function activeDomain_() {
  const cell = SpreadsheetApp.getCurrentCell();
  const domain = normalizeDomain_(cell ? cell.getValue() : '');
  if (!isDomain_(domain)) throw new Error('Click a cell that contains a domain, such as stripe.com.');
  return domain;
}

/**
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function sheetByName_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`The sheet "${name}" no longer exists.`);
  return sheet;
}

/**
 * Adds a sheet with a bold, frozen header row and returns its name.
 * @param {string} baseName
 * @param {string[]} header
 * @param {Array<Array<string | number | boolean>>} rows
 * @return {string}
 */
function writeSheet_(baseName, header, rows) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const base = baseName.replace(/[[\]*?/\\:]/g, ' ').slice(0, 90); // characters sheet names cannot hold
  let name = base;
  for (let copy = 2; spreadsheet.getSheetByName(name); copy++) name = `${base} (${copy})`;
  const sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.setFrozenRows(1);
  return name;
}
