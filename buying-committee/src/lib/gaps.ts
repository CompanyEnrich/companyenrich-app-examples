import type { RoleSpec } from './types';

const SUGGESTIONS: Record<string, string> = {
  'economic-buyer': 'Ask your champion who owns the budget; it often sits one level above the team lead.',
  champion: 'Start with the most hands-on manager in the team that feels the problem, or grow an end user into a champion.',
  'technical-evaluator': 'Ask the champion who would run the trial; usually a senior engineer in the team that owns the stack.',
  'end-user-lead': 'Find out which team will use it day to day and who manages that team.',
  'security-review': 'Ask early for their vendor security questionnaire and send your security docs up front.',
  'procurement-legal': 'Ask the economic buyer how purchasing works and who signs; plan extra time for legal review.',
};

export function gapSuggestion(roleKey: string): string {
  return SUGGESTIONS[roleKey] ?? 'Ask your champion who plays this part in their buying process.';
}

/** "c-suite or vp in engineering-technical, c-suite/information-technology-executive" */
export function describeFilters(role: RoleSpec): string {
  const departments =
    role.department.length === 0
      ? 'any department'
      : role.department.length > 3
        ? `${role.department.slice(0, 3).join(', ')} (+${role.department.length - 3} more)`
        : role.department.join(', ');
  const titles = role.position.length > 0 ? ` with a title containing ${role.position.map((phrase) => `"${phrase}"`).join(' or ')}` : '';
  return `${role.seniority.join(' or ')} in ${departments}${titles}`;
}
