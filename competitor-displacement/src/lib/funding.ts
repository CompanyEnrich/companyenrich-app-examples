import type { Company } from '@companyenrich/sdk';

type Financial = NonNullable<Company['financial']>;

/** "series_b" -> "Series B"; values that are already readable ("Series C") pass through. */
export function formatRoundType(type: string): string {
  const words = type.replace(/_+/g, ' ').trim();
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/^Series ([a-z])\b/, (_, letter: string) => `Series ${letter.toUpperCase()}`);
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** "60000000 USD" -> "$60M", "5000000 EUR" -> "5M EUR". Anything else is kept as given. */
export function formatAmount(amount: string): string {
  const match = /^(\d+(?:\.\d+)?)\s*([A-Z]{3})$/.exec(amount.trim());
  if (!match) return amount;
  const value = compact.format(Number(match[1]));
  return match[2] === 'USD' ? `$${value}` : `${value} ${match[2]}`;
}

/**
 * The latest funding round from the `financial` expansion, e.g. "Series C, $60M, 2026-05-20".
 * Undefined when the expansion was not requested or the company has no disclosed funding.
 */
export function latestRound(financial: Financial | null | undefined): string | undefined {
  if (!financial) return undefined;
  const [round] = (financial.fundingRounds ?? [])
    .filter((candidate) => candidate.date)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

  const type = round?.type ?? financial.fundingStage;
  const date = round?.date ?? financial.fundingDate;
  const parts = [type && formatRoundType(type), round?.amount && formatAmount(round.amount), date?.slice(0, 10)].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
