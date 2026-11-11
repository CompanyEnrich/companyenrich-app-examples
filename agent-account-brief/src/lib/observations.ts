import { count, departmentLabel, fundingStage, isoDate, listing, monthsAgo, monthsBetween, percent } from './format';
import type { Research } from './pipeline';

const RECENT_FUNDING_MONTHS = 18;
const FLAT_CHANGE = 0.02;
const FAST_GROWTH = 0.1;
const TECH_SHOWN = 6;

/**
 * Rule-based talking points for pipeline mode. Each rule fires only when its data
 * is present, and each sentence cites the fields it rests on.
 */
export function observations(research: Research, now: Date): string[] {
  const { company, workforce, lookalikes } = research;
  const notes: string[] = [];
  const financial = company.financial;

  if (financial?.fundingStage && financial.fundingDate) {
    const event = `${fundingStage(financial.fundingStage)} on ${isoDate(financial.fundingDate)}, ${monthsAgo(monthsBetween(financial.fundingDate, now))}`;
    const cite = '[company.financial.fundingStage][company.financial.fundingDate]';
    if (financial.fundingStage.includes('secondary')) {
      notes.push(`Latest funding event: ${event} ${cite}. A secondary sale moves existing shares; it does not by itself mean new budget.`);
    } else if (monthsBetween(financial.fundingDate, now) <= RECENT_FUNDING_MONTHS) {
      notes.push(`Last round: ${event} ${cite}. Fresh funding usually comes with new budget and hiring.`);
    } else {
      notes.push(`Last round: ${event} ${cite}. With no recent round, lead with efficiency rather than growth spend.`);
    }
  }

  if (financial?.stockSymbol) {
    notes.push(
      `Publicly traded (${listing(financial.stockSymbol, financial.stockExchange)}) [company.financial.stockSymbol]. Expect a formal procurement and security review.`,
    );
  }

  if (workforce) {
    const [largest, share] = Object.entries(workforce.departmentShare)[0] ?? [];
    if (largest && share !== undefined) {
      notes.push(
        `${departmentLabel(largest)} is ${percent(share)} of observed headcount (${count(workforce.departmentHeadcount[largest] ?? 0)} of ${count(workforce.observedEmployeeCount)}) [workforce.departmentHeadcount.${largest}][workforce.observedEmployeeCount].`,
      );
    }

    const change = workforce.change12m;
    if (change) {
      const span = `${count(change.fromCount)} in ${change.fromDate.slice(0, 7)} to ${count(change.toCount)} in ${change.toDate.slice(0, 7)}`;
      notes.push(
        Math.abs(change.pct) < FLAT_CHANGE
          ? `Observed headcount is flat over 12 months (${span}) [workforce.change12m].`
          : `Observed headcount ${change.pct > 0 ? 'up' : 'down'} ${percent(Math.abs(change.pct))} over 12 months (${span}) [workforce.change12m].`,
      );
    }

    const fastest = Object.entries(workforce.departmentChange12m ?? {})
      .filter(([, growth]) => growth.pct >= FAST_GROWTH)
      .sort((a, b) => b[1].pct - a[1].pct)[0];
    if (fastest) {
      const [department, growth] = fastest;
      notes.push(
        `${departmentLabel(department)} is the fastest-growing function: ${count(growth.from)} to ${count(growth.to)} (${percent(growth.pct, true)}) [workforce.departmentChange12m.${department}].`,
      );
    }
  }

  const people = research.peopleGroups.flatMap((group) => group.people);
  const newInSeat = people.filter((person) => person.tenureYears !== undefined && person.tenureYears < 1);
  if (newInSeat.length > 0) {
    notes.push(
      `${newInSeat.length} of ${people.length} leaders found started their current role within the last year [people.tenureYears]. New leaders often review tools and vendors early.`,
    );
  }

  const technologies = company.technologies ?? [];
  if (technologies.length > 0) {
    const shown = technologies.slice(0, TECH_SHOWN);
    const total = company.technologiesTotal ?? technologies.length;
    notes.push(
      `Tracked technologies include ${shown.join(', ')} (${shown.length} of ${total} shown) [company.technologies][company.technologiesTotal].`,
    );
  }

  const closest = lookalikes?.[0];
  if (closest?.score !== undefined) {
    notes.push(
      `Closest lookalike: ${closest.name ?? closest.domain} (${closest.domain}, score ${closest.score}) [lookalikes[0].name][lookalikes[0].score]. A customer story from a similar company is a natural opener.`,
    );
  }

  return notes;
}
