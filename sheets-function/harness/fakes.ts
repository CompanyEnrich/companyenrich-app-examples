/**
 * In-memory stand-ins for the Apps Script services the script uses. They
 * implement only the methods the script calls, with the same behaviour where
 * it matters (property quotas, setValues dimension checks, sheet name clashes).
 */

export class FakeCache {
  readonly store = new Map<string, string>();

  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  getAll(keys: string[]): Record<string, string> {
    const found: Record<string, string> = {};
    for (const key of keys) {
      const value = this.store.get(key);
      if (value !== undefined) found[key] = value;
    }
    return found;
  }

  put(key: string, value: string): void {
    this.store.set(key, value);
  }

  putAll(values: Record<string, string>): void {
    for (const [key, value] of Object.entries(values)) this.store.set(key, value);
  }

  remove(key: string): void {
    this.store.delete(key);
  }

  removeAll(keys: string[]): void {
    for (const key of keys) this.store.delete(key);
  }
}

/** A property store that, like Apps Script's, refuses writes past its quota. */
export class FakeProperties {
  readonly store: Map<string, string>;

  constructor(
    initial: Record<string, string> = {},
    readonly quotaBytes = 500 * 1024,
  ) {
    this.store = new Map(Object.entries(initial));
  }

  getProperty(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  getProperties(): Record<string, string> {
    return Object.fromEntries(this.store);
  }

  getKeys(): string[] {
    return [...this.store.keys()];
  }

  setProperty(key: string, value: string): this {
    return this.setProperties({ [key]: value });
  }

  setProperties(values: Record<string, string>): this {
    const next = new Map(this.store);
    for (const [key, value] of Object.entries(values)) next.set(key, String(value));
    if (sizeInBytes(next) > this.quotaBytes) {
      throw new Error('You have exceeded the property storage quota. Please remove some properties and try again.');
    }
    for (const [key, value] of next) this.store.set(key, value);
    return this;
  }

  deleteProperty(key: string): this {
    this.store.delete(key);
    return this;
  }

  sizeInBytes(): number {
    return sizeInBytes(this.store);
  }
}

function sizeInBytes(store: Map<string, string>): number {
  let bytes = 0;
  for (const [key, value] of store) bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  return bytes;
}

export class FakeHttpResponse {
  constructor(
    private readonly status: number,
    private readonly body: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  getResponseCode(): number {
    return this.status;
  }

  getContentText(): string {
    return this.body;
  }

  getHeaders(): Record<string, string> {
    return this.headers;
  }
}

/** The parts of a UrlFetchApp request a test can look at. */
export interface RecordedRequest {
  method: string;
  url: string;
  /** Path below /v2, for example "/companies/enrich". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Decides how the fake API answers a request; throw to simulate a network failure. */
export type ApiHandler = (request: RecordedRequest) => FakeReply;

export interface UrlFetchParams {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  contentType?: string;
  payload?: string;
  muteHttpExceptions?: boolean;
}

export class FakeUrlFetchApp {
  readonly requests: RecordedRequest[] = [];

  constructor(public handler: ApiHandler) {}

  fetch(url: string, params: UrlFetchParams = {}): FakeHttpResponse {
    const parsed = new URL(url);
    const request: RecordedRequest = {
      method: (params.method ?? 'get').toUpperCase(),
      url,
      path: parsed.pathname.replace(/^\/v2/, ''),
      query: parsed.searchParams,
      headers: params.headers ?? {},
      body: params.payload === undefined ? undefined : JSON.parse(params.payload),
    };
    this.requests.push(request);
    const reply = this.handler(request);
    const status = reply.status ?? 200;
    if (status >= 400 && !params.muteHttpExceptions) throw new Error(`Request failed for ${url} returned code ${status}`);
    return new FakeHttpResponse(status, JSON.stringify(reply.body ?? {}), reply.headers);
  }

  fetchAll(requests: Array<UrlFetchParams & { url: string }>): FakeHttpResponse[] {
    return requests.map((request) => this.fetch(request.url, request));
  }

  /** Requests to one API path, for example "/companies/enrich/batch". */
  to(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }
}

export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly column: number,
    private readonly numRows: number,
    private readonly numColumns: number,
  ) {}

  getSheet(): FakeSheet {
    return this.sheet;
  }

  getRow(): number {
    return this.row;
  }

  getColumn(): number {
    return this.column;
  }

  getNumRows(): number {
    return this.numRows;
  }

  getNumColumns(): number {
    return this.numColumns;
  }

  getA1Notation(): string {
    const start = `${columnLetter(this.column)}${this.row}`;
    const end = `${columnLetter(this.column + this.numColumns - 1)}${this.row + this.numRows - 1}`;
    return start === end ? start : `${start}:${end}`;
  }

  getValue(): unknown {
    return this.sheet.cell(this.row, this.column);
  }

  getValues(): unknown[][] {
    return Array.from({ length: this.numRows }, (_, r) =>
      Array.from({ length: this.numColumns }, (_, c) => this.sheet.cell(this.row + r, this.column + c)),
    );
  }

  setValues(values: unknown[][]): this {
    if (values.length !== this.numRows || values.some((row) => row.length !== this.numColumns)) {
      throw new Error(`The data has the wrong size for the range ${this.getA1Notation()}.`);
    }
    values.forEach((row, r) => row.forEach((value, c) => this.sheet.setCell(this.row + r, this.column + c, value)));
    return this;
  }

  setFontWeight(): this {
    return this;
  }
}

export class FakeSheet {
  frozenRows = 0;

  constructor(
    private readonly name: string,
    /** Cell values by row, 0-based; missing cells read as ''. */
    readonly rows: unknown[][] = [],
  ) {}

  getName(): string {
    return this.name;
  }

  cell(row: number, column: number): unknown {
    return this.rows[row - 1]?.[column - 1] ?? '';
  }

  setCell(row: number, column: number, value: unknown): void {
    while (this.rows.length < row) this.rows.push([]);
    const cells = this.rows[row - 1]!;
    while (cells.length < column) cells.push('');
    cells[column - 1] = value;
  }

  getLastRow(): number {
    let last = this.rows.length;
    while (last > 0 && this.rows[last - 1]!.every((value) => value === '' || value === undefined)) last--;
    return last;
  }

  getRange(rowOrA1: number | string, column = 1, numRows = 1, numColumns = 1): FakeRange {
    if (typeof rowOrA1 === 'string') return this.rangeFromA1(rowOrA1);
    return new FakeRange(this, rowOrA1, column, numRows, numColumns);
  }

  insertColumnsAfter(column: number, howMany: number): void {
    for (const cells of this.rows) {
      if (cells.length > column) cells.splice(column, 0, ...Array<unknown>(howMany).fill(''));
    }
  }

  setFrozenRows(rows: number): void {
    this.frozenRows = rows;
  }

  /** Values as a plain grid, for assertions. */
  values(): unknown[][] {
    return this.rows.map((cells) => cells.map((value) => value ?? ''));
  }

  private rangeFromA1(a1: string): FakeRange {
    const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a1);
    if (!match) throw new Error(`Unsupported A1 notation: ${a1}`);
    const [, startColumn, startRow, endColumn = startColumn, endRow = startRow] = match;
    const row = Number(startRow);
    const column = columnNumber(startColumn!);
    return new FakeRange(this, row, column, Number(endRow) - row + 1, columnNumber(endColumn!) - column + 1);
  }
}

function columnLetter(column: number): string {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

function columnNumber(letters: string): number {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

export class FakeSpreadsheet {
  readonly sheets: FakeSheet[];
  private activeSheet: FakeSheet;
  private activeRange: FakeRange | null = null;

  constructor(sheets: FakeSheet[] = [new FakeSheet('Sheet1')]) {
    this.sheets = sheets;
    this.activeSheet = sheets[0]!;
  }

  getActiveSheet(): FakeSheet {
    return this.activeSheet;
  }

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.find((sheet) => sheet.getName() === name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    this.activeSheet = sheet;
    this.activeRange = null;
    return sheet;
  }

  /** Simulates the user selecting cells, for example select('Sheet1', 'A1:A4'). */
  select(sheetName: string, a1: string): void {
    const sheet = this.getSheetByName(sheetName);
    if (!sheet) throw new Error(`No sheet named ${sheetName}`);
    this.activeSheet = sheet;
    this.activeRange = sheet.getRange(a1);
  }

  getActiveRange(): FakeRange | null {
    return this.activeRange;
  }

  getCurrentCell(): FakeRange | null {
    const range = this.activeRange;
    return range ? range.getSheet().getRange(range.getRow(), range.getColumn()) : null;
  }
}

/** Scripted answers for SpreadsheetApp.getUi() dialogs. */
export class FakeUi {
  readonly ButtonSet = { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' };
  readonly Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' };
  readonly menus: Array<{ name: string; items: Array<[string, string] | 'separator'> }> = [];
  readonly alerts: string[] = [];
  readonly sidebars: unknown[] = [];
  /** Answers for the next prompt() calls: text typed, and whether OK was pressed. */
  promptAnswers: Array<{ text: string; ok: boolean }> = [];
  /** Button returned by alert() dialogs that offer a choice. */
  alertAnswer = 'OK';

  createMenu(name: string) {
    const menu = { name, items: [] as Array<[string, string] | 'separator'> };
    this.menus.push(menu);
    const builder = {
      addItem: (label: string, functionName: string) => (menu.items.push([label, functionName]), builder),
      addSeparator: () => (menu.items.push('separator'), builder),
      addToUi: () => undefined,
    };
    return builder;
  }

  prompt(_title: string, _message: string, _buttons: string) {
    const answer = this.promptAnswers.shift() ?? { text: '', ok: false };
    return {
      getSelectedButton: () => (answer.ok ? this.Button.OK : this.Button.CANCEL),
      getResponseText: () => answer.text,
    };
  }

  alert(titleOrMessage: string, message?: string, buttons?: string): string {
    this.alerts.push(message ?? titleOrMessage);
    return buttons ? this.alertAnswer : this.Button.OK;
  }

  showSidebar(html: unknown): void {
    this.sidebars.push(html);
  }
}

export const fakeHtmlService = {
  createHtmlOutputFromFile(file: string) {
    const output = {
      file,
      title: '',
      setTitle(title: string) {
        output.title = title;
        return output;
      },
    };
    return output;
  },
};
