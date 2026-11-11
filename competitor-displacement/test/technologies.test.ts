import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/lib/errors.js';
import { resolveTechnology } from '../src/lib/technologies.js';
import { fakeApi } from './fake-api.js';

describe('resolveTechnology', () => {
  it('returns the API spelling for an exact match, ignoring case and spaces', async () => {
    const api = fakeApi();
    await expect(resolveTechnology(api.client, '  Zendesk ', '--competitor')).resolves.toBe('zendesk');
    expect(api.callsTo('/v2/technologies/autocomplete')[0]?.query.get('query')).toBe('Zendesk');
  });

  it('accepts an exact match even when longer names share the prefix', async () => {
    const api = fakeApi();
    await expect(resolveTechnology(api.client, 'salesforce', '--mine')).resolves.toBe('salesforce');
  });

  it('stops with the closest suggestions when the input is only a prefix', async () => {
    const api = fakeApi();
    const error = await resolveTechnology(api.client, 'sales', '--competitor').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toContain('--competitor "sales" is not an exact technology name');
    expect((error as Error).message).toContain('salesforce, "salesforce service cloud", "salesforce account engagement"');
  });

  it('says when nothing matches at all', async () => {
    const api = fakeApi();
    await expect(resolveTechnology(api.client, 'nosuchtool', '--mine')).rejects.toThrow('not a known technology');
  });

  it('rejects an empty value without calling the API', async () => {
    const api = fakeApi();
    await expect(resolveTechnology(api.client, '   ', '--competitor')).rejects.toBeInstanceOf(UsageError);
    expect(api.calls).toHaveLength(0);
  });
});
