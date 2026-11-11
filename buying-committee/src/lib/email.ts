import type { PersonEmail } from '@companyenrich/sdk';
import type { EnrichClient } from './client';
import { PRICES, type CreditBudget } from './credits';
import { normalizeDomain } from './domains';
import { mayHaveBeenCharged, PAID_GET_OPTIONS, retryOnRateLimit } from './paid-calls';
import { UserFacingError } from './user-error';

export interface EmailReveal {
  personId: string;
  domain: string;
  status: PersonEmail['status'];
  email: string | null;
  /** `unknown`, `medium`, `high` or `very-high`. Always show it next to the email. */
  certainty: PersonEmail['certainty'] | null;
}

/** CompanyEnrich person ids are positive 64-bit integers. */
export const PERSON_ID_PATTERN = /^[1-9]\d{0,19}$/;

/**
 * One person at a time, on purpose: each newly found email costs 10 credits.
 * Repeating a lookup you already paid for is free, but the ledger cannot know that,
 * so a found email is always counted as 10.
 */
export async function revealEmail(client: EnrichClient, personId: string, domainInput: string, budget: CreditBudget): Promise<EmailReveal> {
  if (!PERSON_ID_PATTERN.test(personId)) throw new UserFacingError(`Not a valid person id: ${personId}`);
  const domain = normalizeDomain(domainInput);
  if (!domain) throw new UserFacingError(`Not a valid domain: ${domainInput}`);

  if (!budget.reserve(PRICES.emailFound)) {
    throw new UserFacingError(`An email reveal can cost ${PRICES.emailFound} credits, but only ${budget.available} are left under the cap.`);
  }
  let charged = 0;
  try {
    // Person ids are 64-bit; the SDK accepts them as strings to avoid precision loss.
    const result = await retryOnRateLimit(() => client.people.findEmail(personId, { domain }, PAID_GET_OPTIONS));
    charged = result.status === 'found' ? PRICES.emailFound : 0;
    return {
      personId,
      domain: result.domain,
      status: result.status,
      email: result.status === 'found' ? (result.email ?? null) : null,
      certainty: result.status === 'found' ? (result.certainty ?? null) : null,
    };
  } catch (error) {
    if (mayHaveBeenCharged(error)) charged = PRICES.emailFound;
    throw error;
  } finally {
    budget.settle(PRICES.emailFound, charged);
  }
}
