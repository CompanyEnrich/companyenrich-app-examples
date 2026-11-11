import { describe, expect, it } from 'vitest';
import { choosePersona, describePersonaFilter, PERSONAS, personFilter } from '../src/lib/personas.js';

describe('choosePersona', () => {
  it.each([
    ['zendesk', 'customer-service'],
    ['intercom', 'customer-service'],
    ['salesforce service cloud', 'customer-service'],
    ['salesforce account engagement', 'marketing-operations'],
    ['marketo', 'marketing-operations'],
    ['snowflake', 'data-engineering'],
    ['datadog', 'engineering-devops'],
    ['new relic', 'engineering-devops'],
    ['okta', 'information-security'],
    ['hubspot', 'revenue-operations'],
    ['salesforce', 'revenue-operations'],
    ['zoho crm', 'revenue-operations'],
  ])('maps %s to %s', (technology, persona) => {
    expect(choosePersona(technology).name).toBe(persona);
  });

  it('matches whole words only', () => {
    expect(choosePersona('intercomly').name).toBe('technology-leadership');
    expect(choosePersona('mapmaker').name).toBe('technology-leadership'); // contains "apm" inside a word
  });

  it('falls back to the default buyer for tools no rule covers', () => {
    const choice = choosePersona('wordpress');
    expect(choice.name).toBe('technology-leadership');
    expect(choice.reason).toContain('no keyword rule matched');
  });

  it('lets --persona override the lookup', () => {
    const choice = choosePersona('zendesk', 'revenue-operations');
    expect(choice.name).toBe('revenue-operations');
    expect(choice.reason).toBe('set with --persona');
  });

  it('explains which keyword matched', () => {
    expect(choosePersona('salesforce service cloud').reason).toBe('"salesforce service cloud" looks like support / helpdesk, keyword "service cloud"');
  });
});

describe('persona filters', () => {
  it('scopes a persona level to one account domain', () => {
    expect(personFilter(PERSONAS['customer-service'].primary, 'alpha.example')).toEqual({
      department: ['operations/customer-service-support', 'sales/customer-success'],
      seniority: ['vp', 'head', 'director', 'manager'],
      domain: 'alpha.example',
    });
  });

  it('describes department, title and seniority for the report', () => {
    expect(describePersonaFilter(PERSONAS['data-engineering'].primary)).toBe(
      'departments engineering-technical, information-technology; title contains "data"; seniority vp, head, director, manager',
    );
  });

  it('gives every persona a broader fallback', () => {
    for (const persona of Object.values(PERSONAS)) {
      expect(persona.fallback.department?.length).toBeGreaterThan(0);
      expect(persona.fallback).not.toEqual(persona.primary);
    }
  });
});
