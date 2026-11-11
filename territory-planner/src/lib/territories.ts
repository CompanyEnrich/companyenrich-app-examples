import { UsageError } from './errors.js';
import { balanceOf, partitionBalanced, type Balance } from './partition.js';

export interface StateInput {
  id: number;
  code: string | null;
  name: string;
  companies: number;
  /** What the plan balances: the company count, or a weighted value from weights.ts. */
  weight: number;
  latitude: number | null;
  longitude: number | null;
}

export interface PlanOptions {
  territories: number;
  /** When set, states sharing a region stay in one territory unless that unbalances the plan. */
  regionOf?: (state: StateInput) => string | null;
  /** Highest max/min ratio a region-preserving plan may have before a region is split. */
  regionTolerance?: number;
}

export interface TerritoryPlan {
  /** States per territory, territories ordered west to east, states heaviest first. */
  territories: StateInput[][];
  balance: Balance;
  keptRegions: string[];
  splitRegions: string[];
}

export const DEFAULT_REGION_TOLERANCE = 1.2;

/** Fewest territories worth planning; the CLI enforces the same lower bound. */
export const MIN_TERRITORIES = 2;

/** A unit the partitioner moves as a whole: one state, or every state of a region. */
interface Block {
  key: string;
  region: string | null;
  states: StateInput[];
  weight: number;
}

function stateBlock(state: StateInput): Block {
  return { key: `state:${state.id}`, region: null, states: [state], weight: state.weight };
}

function regionBlocks(states: readonly StateInput[], regionOf: (state: StateInput) => string | null): Block[] {
  const blocks = new Map<string, Block>();
  const singles: Block[] = [];
  for (const state of states) {
    const region = regionOf(state);
    if (!region) {
      singles.push(stateBlock(state));
      continue;
    }
    const block = blocks.get(region) ?? { key: `region:${region}`, region, states: [], weight: 0 };
    block.states.push(state);
    block.weight += state.weight;
    blocks.set(region, block);
  }
  return [...blocks.values(), ...singles];
}

function partitionBlocks(blocks: readonly Block[], territories: number): Block[][] {
  return partitionBalanced(blocks, territories).map((bin) => bin.items);
}

function loadsOf(bins: readonly Block[][]): number[] {
  return bins.map((bin) => bin.reduce((sum, block) => sum + block.weight, 0));
}

function ratioOf(loads: readonly number[]): number {
  return balanceOf(loads).maxMinRatio ?? Number.POSITIVE_INFINITY;
}

/** Great-circle distance in km. Used only to pick the nearest state, so the Earth radius is approximate. */
function distanceKm(a: StateInput, b: StateInput): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude! - a.latitude!) * rad;
  const dLon = (b.longitude! - a.longitude!) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude! * rad) * Math.cos(b.latitude! * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const hasPosition = (state: StateInput) => state.latitude !== null && state.longitude !== null;

/**
 * States with no ICP companies do not change the balance, but routing still needs an owner for
 * them, so each goes to the territory of the nearest state that has companies.
 */
function attachEmptyStates(territories: StateInput[][], empty: readonly StateInput[]): void {
  const owner = new Map<StateInput, number>();
  territories.forEach((states, index) => states.forEach((state) => owner.set(state, index)));
  const placed = [...owner.keys()].filter(hasPosition);
  for (const state of empty) {
    let target = 0;
    if (hasPosition(state) && placed.length > 0) {
      const nearest = placed.reduce((best, candidate) =>
        distanceKm(state, candidate) < distanceKm(state, best) ? candidate : best,
      );
      target = owner.get(nearest)!;
    } else {
      const loads = territories.map((states) => states.reduce((sum, s) => sum + s.weight, 0));
      target = loads.indexOf(Math.min(...loads));
    }
    territories[target]!.push(state);
  }
}

/** Weighted mean longitude of a territory, used to number territories west to east. */
function meanLongitude(states: readonly StateInput[]): number | null {
  const located = states.filter((state) => hasPosition(state) && state.weight > 0);
  const weight = located.reduce((sum, state) => sum + state.weight, 0);
  if (weight === 0) return null;
  return located.reduce((sum, state) => sum + state.longitude! * state.weight, 0) / weight;
}

function byWeightThenName(a: StateInput, b: StateInput): number {
  return b.weight - a.weight || a.name.localeCompare(b.name);
}

/**
 * Splits states into balanced territories.
 *
 * Without regions every state is its own block. With `regionOf`, each region starts as one block;
 * while the plan is less even than max(regionTolerance, the ratio an unconstrained plan reaches),
 * the heaviest region still in one piece is split into its states and the plan is redone.
 */
export function planTerritories(states: readonly StateInput[], options: PlanOptions): TerritoryPlan {
  const { territories: count, regionOf, regionTolerance = DEFAULT_REGION_TOLERANCE } = options;
  const withCompanies = states.filter((state) => state.weight > 0);
  if (withCompanies.length < count) {
    // The CLI plans at least 2 territories, so only suggest fewer when that is still possible.
    const advice = withCompanies.length >= MIN_TERRITORIES
      ? `Use --territories ${withCompanies.length} or fewer, or widen the ICP.`
      : 'Widen the ICP filter or pick another --country.';
    throw new UsageError(
      `Only ${withCompanies.length} ${withCompanies.length === 1 ? 'state has' : 'states have'} ICP companies, so ${count} territories would leave some empty. ${advice}`,
    );
  }

  const singles = withCompanies.map(stateBlock);
  let blocks = regionOf ? regionBlocks(withCompanies, regionOf) : singles;
  let bins = partitionBlocks(blocks, count);
  const splitRegions: string[] = [];

  if (regionOf) {
    const target = Math.max(regionTolerance, ratioOf(loadsOf(partitionBlocks(singles, count))));
    while (ratioOf(loadsOf(bins)) > target) {
      const splittable = blocks
        .filter((block) => block.states.length > 1)
        .sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
      const heaviest = splittable[0];
      if (!heaviest) break;
      blocks = blocks.flatMap((block) => (block === heaviest ? block.states.map(stateBlock) : [block]));
      splitRegions.push(heaviest.region!);
      bins = partitionBlocks(blocks, count);
    }
  }

  const territories = bins.map((bin) => bin.flatMap((block) => block.states));
  const loads = territories.map((states) => states.reduce((sum, state) => sum + state.weight, 0));
  attachEmptyStates(territories, states.filter((state) => state.weight <= 0));

  const longitudes = territories.map(meanLongitude);
  const order = territories.map((_, index) => index);
  if (longitudes.every((value) => value !== null)) {
    order.sort((a, b) => longitudes[a]! - longitudes[b]! || a - b);
  }

  return {
    territories: order.map((index) => territories[index]!.sort(byWeightThenName)),
    balance: balanceOf(order.map((index) => loads[index]!)),
    keptRegions: blocks.filter((block) => block.region !== null).map((block) => block.region!).sort(),
    splitRegions,
  };
}
