import {
  ApiError,
  AuthenticationError,
  NotFoundError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
  type Company,
  type CompanyEnrich,
} from '@companyenrich/sdk';
import { createLimiter, type Limiter } from '../concurrency.ts';
import { normalizeDomain } from '../domains.ts';
import { CREDITS_PER_COMPANY } from '../generate.ts';

/** The fields the model gets back. A small projection keeps tool results short and cheap. */
function projectCompany(company: Company) {
  return {
    found: true,
    name: company.name,
    domain: company.domain,
    type: company.type,
    foundedYear: company.foundedYear,
    employees: company.employees,
    revenue: company.revenue,
    industry: company.industry,
    industries: company.industries,
    categories: company.categories,
    headquarters: {
      country: company.location?.country ?? null,
      state: company.location?.state?.name ?? null,
      city: company.location?.city?.name ?? null,
    },
    financial: company.financial
      ? {
          totalFundingUsd: company.financial.totalFunding,
          fundingStage: company.financial.fundingStage,
          fundingDate: company.financial.fundingDate,
          stockSymbol: company.financial.stockSymbol,
          stockExchange: company.financial.stockExchange,
        }
      : null,
    updatedAt: company.updatedAt,
  };
}

export interface LookupOptions {
  maxCredits: number;
  /** Shared cap on simultaneous API requests across every question. Defaults to 4. */
  limiter?: Limiter;
  /** Base wait before retrying a 429. A 429 is never charged, so it is safe to retry. */
  rateLimitDelayMs?: number;
}

const RATE_LIMIT_RETRIES = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Looks companies up by domain for the `enrich_company` tool.
 *
 * - Results are cached by normalized domain, so 9 questions about one company cost one lookup.
 *   Concurrent calls for the same domain share one request.
 * - At most 4 requests run at once across all questions, however many tool calls the model makes.
 * - Spending stops at `maxCredits`. A failure that may have been billed (5xx, timeout, lost connection)
 *   keeps its credits counted, because the API may have charged for it.
 * - Paid requests are sent with `maxRetries: 0`, so one reservation always matches one request.
 * - Errors that would fail every lookup (bad key, no credits) are kept in `fatal` so the run can stop.
 */
export class CompanyLookup {
  readonly #client: CompanyEnrich;
  readonly #maxCredits: number;
  readonly #limit: Limiter;
  readonly #rateLimitDelayMs: number;
  readonly #cache = new Map<string, Promise<string>>();
  /** Credits for lookups that returned a company. */
  creditsSpent = 0;
  /** Credits for failed lookups that the API may still have charged. */
  creditsUncertain = 0;
  apiCalls = 0;
  fatal: Error | null = null;

  constructor(client: CompanyEnrich, { maxCredits, limiter = createLimiter(4), rateLimitDelayMs = 2000 }: LookupOptions) {
    this.#client = client;
    this.#maxCredits = maxCredits;
    this.#limit = limiter;
    this.#rateLimitDelayMs = rateLimitDelayMs;
  }

  /** Returns the company record as JSON text for the model. */
  lookup(input: string): Promise<string> {
    const domain = normalizeDomain(input);
    if (!domain.includes('.')) return Promise.reject(new Error(`"${input}" is not a domain. Pass one like stripe.com.`));

    const cached = this.#cache.get(domain);
    if (cached) return cached;

    if (this.creditsSpent + this.creditsUncertain + CREDITS_PER_COMPANY > this.#maxCredits) {
      return Promise.reject(new Error(`The credit budget of ${this.#maxCredits} is used up, so no lookup was made.`));
    }
    // Reserve the credits before the request so concurrent lookups cannot overshoot the budget.
    this.creditsUncertain += CREDITS_PER_COMPANY;
    const pending = this.#limit(() => this.#fetch(domain));
    this.#cache.set(domain, pending);
    pending.catch(() => this.#cache.delete(domain));
    return pending;
  }

  async #fetch(domain: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      this.apiCalls += 1;
      try {
        const company = await this.#client.companies.enrich({ domain, expand: ['financial'] }, { maxRetries: 0 });
        this.#settle(CREDITS_PER_COMPANY);
        return JSON.stringify(projectCompany(company));
      } catch (error) {
        if (error instanceof RateLimitError && attempt < RATE_LIMIT_RETRIES) {
          await sleep(this.#rateLimitDelayMs * (attempt + 1));
          continue;
        }
        if (error instanceof NotFoundError) {
          // A miss is not charged, and caching it saves asking again.
          this.#settle(0);
          return JSON.stringify({ found: false, domain });
        }
        // A 4xx answer means the request was refused, so nothing was charged. Anything else may have been.
        if (error instanceof ApiError && error.status < 500) this.#settle(0);
        if (
          error instanceof AuthenticationError ||
          error instanceof PaymentRequiredError ||
          error instanceof PermissionDeniedError
        ) {
          this.fatal ??= error;
        }
        throw error;
      }
    }
  }

  /** Moves a reservation out of "uncertain" once the outcome is known. */
  #settle(charged: number) {
    this.creditsUncertain -= CREDITS_PER_COMPANY;
    this.creditsSpent += charged;
  }
}
