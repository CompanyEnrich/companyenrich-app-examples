/**
 * The CompanyEnrich menu. Menu items run with full authorization, so the first
 * one a user clicks is also where Google asks them to approve the scopes in
 * appsscript.json.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CompanyEnrich')
    .addItem('Open sidebar', 'showSidebar')
    .addItem('Set API key', 'setApiKey')
    .addItem('Set daily credit cap', 'setDailyCreditCap')
    .addSeparator()
    .addItem('Clear cached companies', 'clearCachedCompanies')
    .addToUi();
}

/** Runs when the script is installed as an add-on, so the menu appears without a reload. */
function onInstall() {
  onOpen();
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('CompanyEnrich');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Asks for the API key, checks it with the free /v2/me call, and saves it in
 * the user's own properties. The key never touches a cell.
 */
function setApiKey() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt(
    'CompanyEnrich API key',
    'Paste your key from https://companyenrich.com/dashboard. It is saved in your user properties, not in the spreadsheet.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const key = answer.getResponseText().trim();
  if (!key) {
    ui.alert('No key entered, so nothing was saved.');
    return;
  }
  let me;
  try {
    me = ceMe_(key);
  } catch (error) {
    ui.alert(`The key was not saved. ${errorMessage_(error)}`);
    return;
  }
  PropertiesService.getUserProperties().setProperty(CE_KEY_PROPERTY, key);
  ui.alert(`Key saved. You have ${formatCredits_(remainingCredits_(me))} credits left.`);
}

/** Changes this spreadsheet's daily credit cap (see Budget.js). */
function setDailyCreditCap() {
  const ui = SpreadsheetApp.getUi();
  const { cap, spent } = readBudget_();
  const answer = ui.prompt(
    'Daily credit cap',
    `Most credits this spreadsheet may spend per day (UTC), for formulas and the sidebar together. ` +
      `Now ${cap}; ${spent} used today. Enter a whole number, or 0 to block paid lookups.`,
    ui.ButtonSet.OK_CANCEL,
  );
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const value = Number(answer.getResponseText().trim());
  if (!Number.isInteger(value) || value < 0) {
    ui.alert('The cap must be a whole number of credits, 0 or more. Nothing was changed.');
    return;
  }
  setDocumentProperties_({ [CE_CAP_PROPERTY]: String(value) });
  ui.alert(`Daily credit cap set to ${value} credits.`);
}

function clearCachedCompanies() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Clear cached companies?',
    'Formulas will look these companies up again, and pay for them again, the next time they recalculate.',
    ui.ButtonSet.OK_CANCEL,
  );
  if (answer !== ui.Button.OK) return;
  ui.alert(`Removed ${clearCompanyCache_()} cached companies.`);
}

/**
 * @param {{credits: {used: number, total: number}}} me The /v2/me response.
 * @return {number}
 */
function remainingCredits_(me) {
  return Math.round((me.credits.total - me.credits.used) * 100) / 100;
}

/**
 * @param {number} credits
 * @return {string} For example "1,234.5".
 */
function formatCredits_(credits) {
  return credits.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
