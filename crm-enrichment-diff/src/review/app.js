// Runs inside review.html. No server and no dependencies: the diff is embedded as JSON,
// approvals live in memory (and in localStorage when the browser allows it), and the
// approved patch is built here and downloaded as a CSV.
(function () {
  'use strict';

  const data = JSON.parse(document.getElementById('review-data').textContent);
  const MAX_ROWS = 2000;
  const CHANGE_TYPES = ['fill', 'conflict', 'same', 'api-missing'];
  const ACTIONS = ['update', 'review', 'skip', 'none'];
  const storageKey = 'crm-enrichment-diff:' + data.runId;

  const keyOf = (cell) => cell.recordId + '\u0000' + cell.field;
  const isApprovable = (cell) => cell.action === 'update' || cell.action === 'review';

  // Updates the rules propose start approved; review items start rejected.
  function proposedApprovals() {
    const approvals = new Map();
    for (const cell of data.cells) {
      if (isApprovable(cell)) approvals.set(keyOf(cell), cell.action === 'update');
    }
    return approvals;
  }

  let approvals = proposedApprovals();
  restoreApprovals();

  const filters = { changes: new Set(['fill', 'conflict']), column: '', action: '', search: '' };
  const $ = (id) => document.getElementById(id);

  function element(tag, attributes, children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (name === 'text') node.textContent = value;
      else if (name === 'className') node.className = value;
      else node.setAttribute(name, value);
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }

  function saveApprovals() {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...approvals]));
    } catch (error) {
      // Storage can be unavailable (private windows, file:// restrictions). Approvals still work in memory.
    }
  }

  function restoreApprovals() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      for (const [key, value] of saved) if (approvals.has(key)) approvals.set(key, Boolean(value));
    } catch (error) {
      // Ignore unreadable or unavailable storage and keep the proposed approvals.
    }
  }

  function visibleCells() {
    const search = filters.search.trim().toLowerCase();
    return data.cells.filter(
      (cell) =>
        filters.changes.has(cell.change) &&
        (!filters.column || cell.column === filters.column) &&
        (!filters.action || cell.action === filters.action) &&
        (!search || (cell.company + ' ' + cell.domain + ' ' + cell.recordId).toLowerCase().includes(search)),
    );
  }

  function setApproval(cells, value) {
    for (const cell of cells) if (isApprovable(cell)) approvals.set(keyOf(cell), value);
    saveApprovals();
    render();
  }

  function valueCell(text, extra, placeholder) {
    const td = element('td', { className: 'value' });
    if (text) td.append(text);
    else td.append(element('span', { className: 'empty-value', text: placeholder || 'empty' }));
    if (extra) td.append(extra);
    return td;
  }

  function cellRow(cell) {
    const approvable = isApprovable(cell);
    const checkbox = element('input', {
      type: 'checkbox',
      'data-key': keyOf(cell),
      'aria-label': 'Approve ' + cell.column + ' for ' + cell.company,
    });
    checkbox.checked = approvable && approvals.get(keyOf(cell)) === true;
    checkbox.disabled = !approvable;

    return element('tr', { className: 'is-' + cell.action }, [
      element('td', { text: cell.column }),
      element('td', {}, [element('span', { className: 'badge ' + cell.change, text: cell.change })]),
      valueCell(cell.crmValue),
      valueCell(cell.apiValue, cell.note ? element('span', { className: 'note', text: cell.note }) : null),
      approvable ? valueCell(cell.newValue) : valueCell('', null, 'no change'),
      element('td', {}, [
        document.createTextNode(cell.action),
        element('span', { className: 'reason', text: data.reasonLabels[cell.reason] || cell.reason }),
      ]),
      element('td', { className: 'approve' }, [checkbox]),
    ]);
  }

  function recordRow(first, count) {
    const meta = [first.domain, 'Record ID ' + first.recordId].join(' · ');
    return element('tr', { className: 'record' }, [
      element('th', { colspan: '7', scope: 'colgroup' }, [
        document.createTextNode(first.company),
        element('span', { className: 'record-meta', text: meta }),
        count > 0
          ? element('span', { className: 'record-actions' }, [
              element('button', { type: 'button', className: 'small', 'data-record': first.recordId, 'data-approve': 'true', text: 'Approve all' }),
              element('button', { type: 'button', className: 'small', 'data-record': first.recordId, 'data-approve': 'false', text: 'Reject all' }),
            ])
          : null,
      ]),
    ]);
  }

  function renderRows(cells) {
    const tbody = $('rows');
    tbody.replaceChildren();
    const shown = cells.slice(0, MAX_ROWS);
    const approvableByRecord = new Map();
    for (const cell of shown) {
      if (isApprovable(cell)) approvableByRecord.set(cell.recordId, (approvableByRecord.get(cell.recordId) || 0) + 1);
    }
    let currentRecord = null;
    for (const cell of shown) {
      if (cell.recordId !== currentRecord) {
        currentRecord = cell.recordId;
        tbody.append(recordRow(cell, approvableByRecord.get(cell.recordId) || 0));
      }
      tbody.append(cellRow(cell));
    }
    $('empty').hidden = cells.length > 0;
    $('truncated').hidden = cells.length <= MAX_ROWS;
    $('truncated').textContent =
      'Showing the first ' + MAX_ROWS + ' of ' + cells.length + ' cells. Narrow the filters to see the rest.';
  }

  function approvedCells() {
    return data.cells.filter((cell) => isApprovable(cell) && approvals.get(keyOf(cell)) === true);
  }

  function renderCount() {
    const approved = approvedCells();
    const fromReview = approved.filter((cell) => cell.action === 'review').length;
    $('approved-count').textContent =
      approved.length + ' approved change' + (approved.length === 1 ? '' : 's') +
      (fromReview ? ' (' + fromReview + ' from review)' : '');
    $('export').disabled = approved.length === 0;
  }

  function render() {
    renderRows(visibleCells());
    renderCount();
  }

  // The same columns, escaping and line endings as patch.csv (src/lib/csv.ts), so `apply` reads both.
  function escapeCsvField(value) {
    return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  }

  // A cell starting with = + - @ tab or CR would run as a formula in a spreadsheet: prefix it with '.
  // `apply` strips the prefix again before writing to the CRM. Plain numbers such as -5 stay as they are.
  function neutralizeFormula(value) {
    return /^'*[=+\-@\t\r]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value) ? "'" + value : value;
  }

  function toPatchRow(cell) {
    return {
      record_id: cell.recordId,
      company: cell.company,
      domain: cell.domain,
      column: cell.column,
      field: cell.field,
      change: cell.change,
      action: cell.action,
      crm_value: cell.crmValue,
      api_value: cell.apiValue,
      new_value: cell.newValue,
    };
  }

  function buildPatchCsv() {
    const rows = approvedCells().map(toPatchRow);
    const lines = [data.patchColumns].concat(rows.map((row) => data.patchColumns.map((column) => row[column] ?? '')));
    return lines.map((cells) => cells.map((cell) => escapeCsvField(neutralizeFormula(cell))).join(',')).join('\n') + '\n';
  }

  function exportPatch() {
    const blob = new Blob([buildPatchCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = element('a', { href: url, download: 'approved-patch-' + data.runId + '.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function count(list, predicate) {
    return list.filter(predicate).length;
  }

  function renderStats() {
    const stats = $('stats');
    for (const change of CHANGE_TYPES) {
      stats.append(element('div', { className: 'stat' }, [
        element('strong', { text: String(count(data.cells, (cell) => cell.change === change)) }),
        element('span', { className: 'badge ' + change, text: change }),
      ]));
    }
    for (const action of ['update', 'review', 'skip']) {
      stats.append(element('div', { className: 'stat' }, [
        element('strong', { text: String(count(data.cells, (cell) => cell.action === action)) }),
        element('span', { text: 'proposed ' + action }),
      ]));
    }
  }

  function renderFilters() {
    const changeSet = $('filter-change');
    for (const change of CHANGE_TYPES) {
      const box = element('input', { type: 'checkbox', value: change });
      box.checked = filters.changes.has(change);
      box.addEventListener('change', () => {
        if (box.checked) filters.changes.add(change);
        else filters.changes.delete(change);
        render();
      });
      changeSet.append(element('label', {}, [box, element('span', { className: 'badge ' + change, text: change })]));
    }
    for (const column of data.columns) $('filter-column').append(element('option', { value: column, text: column }));
    for (const action of ACTIONS) $('filter-action').append(element('option', { value: action, text: action }));
  }

  function renderUnmatched() {
    const list = $('unmatched-list');
    const unmatched = data.records.filter((record) => record.status !== 'found');
    $('unmatched').hidden = unmatched.length === 0;
    for (const record of unmatched) {
      const label = data.statusLabels[record.status] || record.status;
      list.append(element('li', {
        text: record.recordId + ' ' + (record.company || '(no name)') + ' (' + (record.domain || 'no domain') + '): ' + (record.message || label),
      }));
    }
  }

  function wireEvents() {
    $('filter-column').addEventListener('change', (event) => { filters.column = event.target.value; render(); });
    $('filter-action').addEventListener('change', (event) => { filters.action = event.target.value; render(); });
    $('filter-search').addEventListener('input', (event) => { filters.search = event.target.value; render(); });
    $('approve-visible').addEventListener('click', () => setApproval(visibleCells(), true));
    $('reject-visible').addEventListener('click', () => setApproval(visibleCells(), false));
    $('reset').addEventListener('click', () => {
      approvals = proposedApprovals();
      saveApprovals();
      render();
    });
    $('export').addEventListener('click', exportPatch);

    $('rows').addEventListener('change', (event) => {
      const key = event.target.getAttribute('data-key');
      if (!key) return;
      approvals.set(key, event.target.checked);
      saveApprovals();
      renderCount();
    });
    $('rows').addEventListener('click', (event) => {
      const recordId = event.target.getAttribute('data-record');
      if (!recordId) return;
      const inRecord = visibleCells().filter((cell) => cell.recordId === recordId);
      setApproval(inRecord, event.target.getAttribute('data-approve') === 'true');
    });
  }

  renderStats();
  renderFilters();
  renderUnmatched();
  wireEvents();
  render();
})();
