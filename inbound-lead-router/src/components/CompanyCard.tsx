import type { CompanyFacts } from '@/lib/company';
import { formatUsd, fundingStageLabel } from '@/lib/format';

export function CompanyCard({ company }: { company: CompanyFacts }) {
  const place = [company.city, company.state?.name, company.country?.name].filter(Boolean).join(', ');
  const funding = company.funding?.stage
    ? [fundingStageLabel(company.funding.stage), company.funding.date?.slice(0, 10), company.funding.totalUsd ? `${formatUsd(company.funding.totalUsd)} total` : null]
        .filter(Boolean)
        .join(' · ')
    : null;
  const rows: [string, string | number | null][] = [
    ['Industry', company.industry],
    ['Employees', company.employees],
    ['Revenue', company.revenue],
    ['Categories', company.categories.join(', ') || null],
    ['Headquarters', place || null],
    ['Founded', company.foundedYear],
    ['Funding', funding],
    ['Technologies', company.technologies?.length ? `${company.technologies.length} detected` : null],
  ];
  return (
    <div>
      <p className="font-semibold">
        {company.name ?? company.domain} <span className="font-normal text-slate-500">{company.domain}</span>
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows
          .filter(([, value]) => value !== null && value !== '')
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-slate-500">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
