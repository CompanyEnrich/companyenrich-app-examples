/**
 * A daily credit cap per spreadsheet, as a backstop against runaway
 * recalculation or a mistake in a big sheet. Every paid call first reserves
 * its worst-case cost against today's ledger (UTC day, stored in document
 * properties) and settles to the real cost afterwards. Reservations happen
 * under the document lock, because Sheets runs custom functions for many
 * cells at the same time.
 *
 * The cap guards against accidents, not people: anyone who can edit the
 * spreadsheet can raise it from the menu.
 */

const CE_DEFAULT_DAILY_CAP = 500;
const CE_LOCK_WAIT_MS = 5000; // short, because a custom function has 30 seconds in total
const CE_CAP_PROPERTY = 'ce:daily-cap';
const CE_SPENT_PREFIX = 'ce:spent:';

/**
 * A reservation remembers the UTC day it was counted on, so settling it later
 * (even after midnight) only ever corrects that day.
 * @typedef {{day: string, credits: number}} Reservation
 */

/**
 * Reserves credits before a paid call. Throws, without spending anything, if
 * today's cap would be exceeded.
 * @param {number} credits Worst-case cost of the call.
 * @return {Reservation}
 */
function reserveCredits_(credits) {
  return credits > 0 ? withDocumentLock_(() => reserveCreditsLocked_(credits)) : { day: todayUtc_(), credits: 0 };
}

/**
 * The same as reserveCredits_, for callers that already hold the document lock.
 * @param {number} credits
 * @return {Reservation}
 */
function reserveCreditsLocked_(credits) {
  const day = todayUtc_();
  if (credits <= 0) return { day, credits: 0 };
  const { cap, spent } = readBudget_();
  if (spent + credits > cap) {
    throw new Error(
      `Daily credit cap reached for this spreadsheet: ${spent} of ${cap} credits used today (UTC), ` +
        `and this needs up to ${credits}. Raise it with CompanyEnrich > Set daily credit cap.`,
    );
  }
  writeSpent_(spent + credits);
  return { day, credits };
}

/**
 * Corrects a reservation to what the call really cost. A reservation from an
 * earlier day is left alone: that day's ledger is gone, and today's must not
 * absorb its refund.
 * @param {Reservation} reservation
 * @param {number} spent
 */
function settleCredits_(reservation, spent) {
  if (reservation.credits === spent) return;
  withDocumentLock_(() => {
    if (reservation.day !== todayUtc_()) return;
    writeSpent_(Math.max(0, readBudget_().spent - reservation.credits + spent));
  });
}

/**
 * What to keep counted after a paid call failed: a 4xx answer is never
 * billed, but after a 5xx or a network failure the charge is unknown, so the
 * worst case stays counted against the cap.
 * @param {unknown} error
 * @param {number} worstCase
 * @return {number}
 */
function chargeAfterFailure_(error, worstCase) {
  const status = statusOf_(error);
  return status >= 400 && status < 500 ? 0 : worstCase;
}

/**
 * Today's cap and the credits this spreadsheet has spent (or reserved) today.
 * @return {{cap: number, spent: number}}
 */
function readBudget_() {
  const properties = PropertiesService.getDocumentProperties();
  const cap = properties.getProperty(CE_CAP_PROPERTY); // validated by setDailyCreditCap
  return {
    cap: cap === null ? CE_DEFAULT_DAILY_CAP : Number(cap),
    spent: Number(properties.getProperty(CE_SPENT_PREFIX + todayUtc_())) || 0,
  };
}

/**
 * Saves today's total and drops the totals of earlier days.
 * @param {number} spent
 */
function writeSpent_(spent) {
  const properties = PropertiesService.getDocumentProperties();
  const today = CE_SPENT_PREFIX + todayUtc_();
  for (const key of properties.getKeys()) {
    if (key.startsWith(CE_SPENT_PREFIX) && key !== today) properties.deleteProperty(key);
  }
  setDocumentProperties_({ [today]: String(spent) });
}

/** @return {string} For example "2026-11-11". */
function todayUtc_() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Runs `task` while holding the document lock, so parallel custom function
 * calls cannot both spend the same headroom or claim the same domain. The
 * wait is short: a custom function has 30 seconds in total.
 * @template T
 * @param {() => T} task
 * @return {T}
 */
function withDocumentLock_(task) {
  const lock = LockService.getDocumentLock();
  if (!lock) return task(); // only bound scripts have a document lock
  if (!lock.tryLock(CE_LOCK_WAIT_MS)) {
    throw new Error('Other cells are busy with CompanyEnrich lookups. Recalculate this cell in a moment.');
  }
  try {
    return task();
  } finally {
    lock.releaseLock();
  }
}
