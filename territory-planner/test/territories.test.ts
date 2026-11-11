import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/lib/errors.js';
import { planTerritories, type StateInput } from '../src/lib/territories.js';
import { US_CENSUS_DIVISIONS, usCensusDivision } from '../src/lib/us-geo.js';
import { loadFixture } from './fake-api.js';

const usStates: StateInput[] = loadFixture('us').states.map((state) => ({ ...state, weight: state.companies }));
const regionOf = (state: StateInput) => usCensusDivision(state.code ?? undefined);

function state(id: number, code: string, weight: number, longitude: number | null = null, latitude: number | null = null): StateInput {
  return { id, code, name: code, companies: weight, weight, latitude, longitude };
}

function territoryOf(plan: { territories: StateInput[][] }): Map<string, number> {
  return new Map(plan.territories.flatMap((states, index) => states.map((s) => [s.code ?? s.name, index] as const)));
}

describe('planTerritories without regions', () => {
  it('places every state exactly once, including states with no companies', () => {
    const plan = planTerritories(usStates, { territories: 4 });
    const placed = plan.territories.flat().map((s) => s.id).sort();
    expect(placed).toEqual(usStates.map((s) => s.id).sort());
    expect(plan.territories.every((states) => states.length > 0)).toBe(true);
  });

  it('numbers territories west to east by weighted mean longitude', () => {
    const plan = planTerritories(
      [state(1, 'E', 10, 20, 0), state(2, 'W', 10, -20, 0), state(3, 'M', 10, 0, 0)],
      { territories: 3 },
    );
    expect(plan.territories.map((states) => states[0]!.code)).toEqual(['W', 'M', 'E']);
  });

  it('gives a state with no companies to the territory of the nearest state', () => {
    const plan = planTerritories(
      [state(1, 'A', 50, -100, 40), state(2, 'B', 50, -70, 40), state(3, 'NEAR_B', 0, -71, 41)],
      { territories: 2 },
    );
    expect(territoryOf(plan).get('NEAR_B')).toBe(territoryOf(plan).get('B'));
  });

  it('refuses more territories than states with companies, suggesting a count the CLI accepts', () => {
    const three = [state(1, 'A', 5), state(2, 'B', 4), state(3, 'C', 3), state(4, 'D', 0)];
    expect(() => planTerritories(three, { territories: 4 })).toThrow(/Only 3 states have ICP companies.*Use --territories 3 or fewer/);
  });

  it('suggests widening the ICP, not --territories 1, when fewer than two states qualify', () => {
    const one = [state(1, 'A', 5), state(2, 'B', 0)];
    expect(() => planTerritories(one, { territories: 2 })).toThrow(UsageError);
    expect(() => planTerritories(one, { territories: 2 })).toThrow(/Only 1 state has ICP companies.*Widen the ICP filter or pick another --country\.$/);
    expect(() => planTerritories([state(1, 'A', 0)], { territories: 2 })).not.toThrow(/--territories 1|--territories 0/);
  });
});

describe('planTerritories with US Census divisions (--keep-regions)', () => {
  it('keeps every division whole unless it was split, and only splits what balance needs', () => {
    const plan = planTerritories(usStates, { territories: 4, regionOf });
    // California alone is over a quarter of the US ICP, so only Pacific must break up.
    expect(plan.splitRegions).toEqual(['Pacific']);
    const owners = territoryOf(plan);
    for (const [division, codes] of Object.entries(US_CENSUS_DIVISIONS)) {
      if (plan.splitRegions.includes(division)) continue;
      const territories = new Set(codes.map((code) => owners.get(code)));
      expect(territories.size, division).toBe(1);
    }
    expect(plan.balance.maxMinRatio!).toBeLessThanOrEqual(1.2);
  });

  it('keeps all divisions whole when they balance on their own', () => {
    // Two divisions of equal weight: a perfect 2-way split without breaking either.
    const states = [
      state(1, 'CT', 30), state(2, 'MA', 30), state(3, 'ME', 40),
      state(4, 'NJ', 50), state(5, 'NY', 40), state(6, 'PA', 10),
    ];
    const plan = planTerritories(states, { territories: 2, regionOf });
    expect(plan.splitRegions).toEqual([]);
    expect(plan.keptRegions).toEqual(['Middle Atlantic', 'New England']);
    expect(plan.balance.maxMinRatio).toBe(1);
  });

  it('splits the heaviest division when keeping it whole is too uneven', () => {
    const states = [
      state(1, 'NY', 60), state(2, 'NJ', 40), state(3, 'PA', 20), // Middle Atlantic: 120
      state(4, 'MA', 20), state(5, 'CT', 20), // New England: 40
    ];
    const whole = planTerritories(states, { territories: 2, regionOf, regionTolerance: 10 });
    expect(whole.splitRegions).toEqual([]);
    expect(whole.balance.maxMinRatio).toBe(3);

    const balanced = planTerritories(states, { territories: 2, regionOf });
    expect(balanced.splitRegions).toEqual(['Middle Atlantic']);
    expect(balanced.balance.maxMinRatio).toBe(1);
    expect(balanced.keptRegions).toEqual(['New England']);
  });

  it('accepts the unconstrained ratio when even full splitting cannot reach the tolerance', () => {
    const plan = planTerritories(usStates, { territories: 6, regionOf });
    const unconstrained = planTerritories(usStates, { territories: 6 });
    expect(plan.balance.maxMinRatio).toBeCloseTo(unconstrained.balance.maxMinRatio!, 6);
    expect(plan.keptRegions.length).toBeGreaterThan(0);
  });
});
