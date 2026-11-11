/**
 * Loads the files in apps-script/ into a Node `vm` context, the way Apps
 * Script does: every file runs as a classic script in one shared global
 * scope. The Google services are passed in, so tests can use fakes and the
 * smoke test can use real HTTP.
 */
import { readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FakeCache, FakeProperties, FakeSpreadsheet, FakeUi, fakeHtmlService, type FakeUrlFetchApp } from './fakes.js';

export const SCRIPT_DIR = new URL('../apps-script/', import.meta.url);

type Fn = (...args: any[]) => any;

/** The global functions tests and the smoke scripts call. */
export interface AppsScript {
  // Custom functions
  COMPANYENRICH: Fn;
  COMPANYENRICH_ROW: Fn;
  COMPANYENRICH_COUNT: Fn;
  // Menu
  onOpen: Fn;
  onInstall: Fn;
  showSidebar: Fn;
  setApiKey: Fn;
  setDailyCreditCap: Fn;
  clearCachedCompanies: Fn;
  // Sidebar server functions
  getSidebarState: Fn;
  estimateEnrichSelection: Fn;
  enrichSelectionChunk: Fn;
  estimateLookalikes: Fn;
  runLookalikes: Fn;
  estimatePeople: Fn;
  runPeople: Fn;
  // Internals with focused tests
  normalizeDomain_: Fn;
  isDomain_: Fn;
  resolveFieldPath_: Fn;
  readField_: Fn;
  ceMe_: Fn;
}

/** Runs every .js file in apps-script/ in a fresh context with the given globals. */
export function loadAppsScript(globals: Record<string, unknown>): { script: AppsScript; context: vm.Context } {
  const context = vm.createContext({ console, ...globals });
  const files = readdirSync(SCRIPT_DIR)
    .filter((file) => file.endsWith('.js'))
    .sort();
  for (const file of files) {
    vm.runInContext(readFileSync(new URL(file, SCRIPT_DIR), 'utf8'), context, { filename: `apps-script/${file}` });
  }
  return { script: context as unknown as AppsScript, context };
}

export interface EnvironmentOptions {
  urlFetch: FakeUrlFetchApp | { fetch: Fn; fetchAll: Fn };
  /** Called after each Utilities.sleep, for example to simulate another cell finishing. */
  onSleep?: (ms: number) => void;
  apiKey?: string | null;
  documentProperties?: FakeProperties;
  cache?: FakeCache;
  spreadsheet?: FakeSpreadsheet;
}

/** Wires the fakes into a loaded script. Anything not passed in starts empty. */
export function createEnvironment(options: EnvironmentOptions) {
  const userProperties = new FakeProperties(options.apiKey ? { COMPANYENRICH_API_KEY: options.apiKey } : {});
  const documentProperties = options.documentProperties ?? new FakeProperties();
  const cache = options.cache ?? new FakeCache();
  const spreadsheet = options.spreadsheet ?? new FakeSpreadsheet();
  const ui = new FakeUi();
  const sleeps: number[] = [];
  const lock = {
    held: false,
    /** Set to true to simulate another execution holding the lock. */
    busy: false,
    tryLock: () => !lock.busy && (lock.held = true),
    releaseLock: () => (lock.held = false),
  };
  // A clock that Utilities.sleep advances, so time limits are tested without waiting.
  const clock = { now: Date.now() };
  class FakeDate extends Date {
    constructor(value?: number | string | Date) {
      super(value ?? clock.now);
    }

    static override now() {
      return clock.now;
    }
  }

  const { script, context } = loadAppsScript({
    UrlFetchApp: options.urlFetch,
    CacheService: { getDocumentCache: () => cache },
    PropertiesService: {
      getUserProperties: () => userProperties,
      getDocumentProperties: () => documentProperties,
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getActiveRange: () => spreadsheet.getActiveRange(),
      getCurrentCell: () => spreadsheet.getCurrentCell(),
      getUi: () => ui,
    },
    HtmlService: fakeHtmlService,
    LockService: { getDocumentLock: () => lock },
    Utilities: {
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock.now += ms;
        options.onSleep?.(ms);
      },
    },
    Date: FakeDate,
  });

  return { script, context, userProperties, documentProperties, cache, spreadsheet, ui, sleeps, lock, clock };
}
