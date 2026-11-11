import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SCRIPT_DIR } from '../harness/load.js';
import { problem, setup } from './helpers.js';

describe('menu', () => {
  it('adds the CompanyEnrich menu on open and on install', () => {
    const { script, ui } = setup();
    script.onOpen();
    script.onInstall();
    expect(ui.menus).toHaveLength(2);
    expect(ui.menus[0]).toEqual({
      name: 'CompanyEnrich',
      items: [
        ['Open sidebar', 'showSidebar'],
        ['Set API key', 'setApiKey'],
        ['Set daily credit cap', 'setDailyCreditCap'],
        'separator',
        ['Clear cached companies', 'clearCachedCompanies'],
      ],
    });
  });

  it('opens Sidebar.html in the sidebar', () => {
    const { script, ui } = setup();
    script.showSidebar();
    expect(ui.sidebars).toEqual([expect.objectContaining({ file: 'Sidebar', title: 'CompanyEnrich' })]);
  });
});

describe('setApiKey', () => {
  it('checks the key with the free /v2/me call and saves it in user properties', () => {
    const { script, ui, urlFetch, userProperties, documentProperties } = setup({ apiKey: null });
    ui.promptAnswers.push({ text: '  new-key  ', ok: true });
    script.setApiKey();
    expect(urlFetch.requests[0]?.headers.Authorization).toBe('Bearer new-key');
    expect(userProperties.getProperty('COMPANYENRICH_API_KEY')).toBe('new-key');
    expect(documentProperties.getKeys()).toEqual([]);
    expect(ui.alerts).toEqual(['Key saved. You have 989.5 credits left.']);
  });

  it('does not save a key the API rejects', () => {
    const { script, ui, userProperties } = setup({ apiKey: null, overrides: { '/me': () => problem(401, 'Invalid key') } });
    ui.promptAnswers.push({ text: 'wrong', ok: true });
    script.setApiKey();
    expect(userProperties.getProperty('COMPANYENRICH_API_KEY')).toBeNull();
    expect(ui.alerts[0]).toBe(
      'The key was not saved. CompanyEnrich rejected the API key (401). Set a valid key with CompanyEnrich > Set API key.',
    );
  });

  it('does nothing when cancelled or left empty', () => {
    const { script, ui, urlFetch, userProperties } = setup({ apiKey: 'old-key' });
    ui.promptAnswers.push({ text: 'ignored', ok: false }, { text: '   ', ok: true });
    script.setApiKey();
    script.setApiKey();
    expect(urlFetch.requests).toHaveLength(0);
    expect(userProperties.getProperty('COMPANYENRICH_API_KEY')).toBe('old-key');
  });
});

describe('project files', () => {
  it('asks for the three minimal OAuth scopes and the V8 runtime', () => {
    const manifest = JSON.parse(readFileSync(new URL('appsscript.json', SCRIPT_DIR), 'utf8'));
    expect(manifest.runtimeVersion).toBe('V8');
    expect(manifest.oauthScopes).toEqual([
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/spreadsheets.currentonly',
      'https://www.googleapis.com/auth/script.container.ui',
    ]);
  });

  it('has a sidebar script that parses', () => {
    const html = readFileSync(new URL('Sidebar.html', SCRIPT_DIR), 'utf8');
    const [, code] = /<script>([\s\S]*)<\/script>/.exec(html) ?? [];
    expect(() => new vm.Script(code ?? '')).not.toThrow();
  });

  it('only calls server functions that exist and are public', () => {
    const { context } = setup();
    const html = readFileSync(new URL('Sidebar.html', SCRIPT_DIR), 'utf8');
    const called = [...html.matchAll(/server\('(\w+)'/g)].map((match) => match[1]!);
    expect(called.length).toBeGreaterThan(5);
    for (const name of new Set(called)) {
      expect(typeof context[name], name).toBe('function');
      expect(name.endsWith('_'), `${name} is private`).toBe(false);
    }
  });
});
