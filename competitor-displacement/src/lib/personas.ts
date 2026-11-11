import type { Department, PersonFilter, Seniority } from './types.js';

/** People filters for one level of a persona. Fields combine with AND; values inside a field with OR. */
export interface PersonaFilter {
  department?: Department[];
  seniority?: Seniority[];
  position?: string[];
}

export interface Persona {
  /** Who usually owns the decision to switch this kind of tool. */
  buyer: string;
  /** The team that runs the tool day to day. */
  primary: PersonaFilter;
  /** Broader leadership of the same function, used at accounts where the primary persona has nobody. */
  fallback: PersonaFilter;
}

const MANAGERS_AND_UP: Seniority[] = ['vp', 'head', 'director', 'manager'];
const LEADERS: Seniority[] = ['c-suite', 'vp', 'head', 'director'];

export const PERSONAS = {
  'revenue-operations': {
    buyer: 'Revenue or sales operations',
    primary: { department: ['sales/revenue-operations', 'sales/sales-operations'], seniority: MANAGERS_AND_UP },
    fallback: { department: ['sales', 'c-suite/sales-executive'], seniority: LEADERS },
  },
  'marketing-operations': {
    buyer: 'Marketing operations',
    primary: { department: ['marketing/marketing-operations', 'marketing/demand-generation'], seniority: MANAGERS_AND_UP },
    fallback: { department: ['marketing', 'c-suite/marketing-executive'], seniority: LEADERS },
  },
  'data-engineering': {
    buyer: 'Data engineering',
    // The department taxonomy has no "data engineering" leaf, so a title phrase narrows engineering and IT.
    primary: { department: ['engineering-technical', 'information-technology'], position: ['data'], seniority: MANAGERS_AND_UP },
    fallback: { department: ['engineering-technical', 'c-suite/information-technology-executive'], seniority: LEADERS },
  },
  'engineering-devops': {
    buyer: 'Engineering and DevOps',
    primary: {
      department: ['engineering-technical/devops', 'engineering-technical/technology-operations', 'information-technology/infrastructure'],
      seniority: MANAGERS_AND_UP,
    },
    fallback: { department: ['engineering-technical', 'c-suite/information-technology-executive'], seniority: LEADERS },
  },
  'information-security': {
    buyer: 'Information security',
    primary: { department: ['information-technology/information-security'], seniority: MANAGERS_AND_UP },
    fallback: { department: ['information-technology', 'c-suite/information-technology-executive'], seniority: LEADERS },
  },
  'customer-service': {
    buyer: 'Customer service and support',
    primary: { department: ['operations/customer-service-support', 'sales/customer-success'], seniority: MANAGERS_AND_UP },
    fallback: { department: ['operations', 'c-suite/operations-executive'], seniority: LEADERS },
  },
  'technology-leadership': {
    buyer: 'Technology leadership (default for unmapped tools)',
    primary: { department: ['c-suite/information-technology-executive', 'information-technology', 'engineering-technical'], seniority: LEADERS },
    fallback: { department: ['c-suite'], seniority: ['c-suite', 'founder', 'owner'] },
  },
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;
export const PERSONA_NAMES = Object.keys(PERSONAS) as PersonaName[];
export const DEFAULT_PERSONA: PersonaName = 'technology-leadership';

export function isPersonaName(value: string): value is PersonaName {
  return Object.hasOwn(PERSONAS, value);
}

/**
 * Keyword lookup from technology name to buyer, checked in order (first match wins). Specific
 * products come before generic vendors, so "salesforce service cloud" maps to support, not CRM.
 * Keywords match whole words in the API's technology name.
 */
export const PERSONA_RULES: readonly { category: string; persona: PersonaName; keywords: readonly string[] }[] = [
  {
    category: 'support / helpdesk',
    persona: 'customer-service',
    keywords: ['zendesk', 'freshdesk', 'help scout', 'gorgias', 'kustomer', 'intercom', 'livechat', 'tawk.to', 'olark', 'service cloud', 'live agent', 'helpdesk', 'help desk'],
  },
  {
    category: 'marketing automation',
    persona: 'marketing-operations',
    keywords: ['marketo', 'pardot', 'account engagement', 'eloqua', 'mailchimp', 'klaviyo', 'activecampaign', 'braze', 'iterable', 'customer.io', 'marketing automation'],
  },
  {
    category: 'data warehouse / ETL',
    persona: 'data-engineering',
    keywords: ['snowflake', 'bigquery', 'redshift', 'databricks', 'fivetran', 'stitch', 'airbyte', 'dbt', 'segment', 'rudderstack', 'hightouch', 'etl', 'data warehouse'],
  },
  {
    category: 'observability / APM',
    persona: 'engineering-devops',
    keywords: ['datadog', 'new relic', 'dynatrace', 'appdynamics', 'sentry', 'honeycomb', 'grafana', 'splunk', 'bugsnag', 'rollbar', 'raygun', 'apm', 'observability', 'monitoring'],
  },
  {
    category: 'security',
    persona: 'information-security',
    keywords: ['okta', 'auth0', 'onelogin', 'crowdstrike', 'sentinelone', 'imperva', 'sucuri', 'zscaler', '1password', 'security', 'waf'],
  },
  {
    category: 'CRM',
    persona: 'revenue-operations',
    keywords: ['salesforce', 'hubspot', 'pipedrive', 'zoho crm', 'freshsales', 'dynamics 365', 'sugarcrm', 'insightly', 'copper', 'crm'],
  },
];

export interface PersonaChoice {
  name: PersonaName;
  persona: Persona;
  /** Why this persona was picked, for the report. */
  reason: string;
}

function containsWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

/** Picks the buyer for a competitor technology, unless --persona overrides it. */
export function choosePersona(technology: string, override?: PersonaName): PersonaChoice {
  if (override) return { name: override, persona: PERSONAS[override], reason: 'set with --persona' };

  const name = technology.toLowerCase();
  for (const rule of PERSONA_RULES) {
    const keyword = rule.keywords.find((candidate) => containsWord(name, candidate));
    if (keyword) return { name: rule.persona, persona: PERSONAS[rule.persona], reason: `"${technology}" looks like ${rule.category}, keyword "${keyword}"` };
  }
  return { name: DEFAULT_PERSONA, persona: PERSONAS[DEFAULT_PERSONA], reason: `no keyword rule matched "${technology}", so the default buyer applies` };
}

/** The people filter for one account: the persona level plus the account's domain. */
export function personFilter(level: PersonaFilter, domain: string): PersonFilter {
  return { ...level, domain };
}

export function describePersonaFilter(level: PersonaFilter): string {
  const parts = [
    level.department && `departments ${level.department.join(', ')}`,
    level.position && `title contains ${level.position.map((phrase) => `"${phrase}"`).join(' or ')}`,
    level.seniority && `seniority ${level.seniority.join(', ')}`,
  ];
  return parts.filter(Boolean).join('; ');
}
