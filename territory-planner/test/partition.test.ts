import { describe, expect, it } from 'vitest';
import {
  assignGreedy,
  balanceOf,
  improveBySwaps,
  partitionBalanced,
  type Bin,
  type WeightedItem,
} from '../src/lib/partition.js';
import { loadFixture } from './fake-api.js';

function itemsFrom(code: 'us' | 'de'): WeightedItem[] {
  return loadFixture(code)
    .states.filter((state) => state.companies > 0)
    .map((state) => ({ key: String(state.id), weight: state.companies }));
}

/** Small deterministic PRNG so the property tests are reproducible. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const next = random(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const loads = (bins: Bin[]) => bins.map((bin) => bin.load);
const keys = (bins: Bin[]) => bins.map((bin) => bin.items.map((item) => item.key));

describe('assignGreedy', () => {
  it('gives each item, heaviest first, to the lightest territory', () => {
    const bins = assignGreedy(
      [7, 6, 5, 4, 3, 2].map((weight) => ({ key: `w${weight}`, weight })),
      2,
    );
    expect(keys(bins)).toEqual([['w7', 'w4', 'w3'], ['w6', 'w5', 'w2']]);
    expect(loads(bins)).toEqual([14, 13]);
  });

  it('rejects a non-positive territory count', () => {
    expect(() => assignGreedy([], 0)).toThrow(RangeError);
  });
});

describe('partitionBalanced on real state counts', () => {
  for (const code of ['us', 'de'] as const) {
    const items = itemsFrom(code);
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    const heaviest = Math.max(...items.map((item) => item.weight));

    for (let k = 2; k <= 8; k++) {
      it(`${code.toUpperCase()}, ${k} territories: largest territory within 1% of the best possible`, () => {
        const balance = balanceOf(loads(partitionBalanced(items, k)));
        // No split can beat the heavier of one even share and the single largest state.
        const lowerBound = Math.max(total / k, heaviest);
        expect(balance.max).toBeLessThanOrEqual(lowerBound * 1.01);
      });
    }
  }

  it('balances the US ICP into 2 or 3 territories within max/min 1.01', () => {
    for (const k of [2, 3]) {
      expect(balanceOf(loads(partitionBalanced(itemsFrom('us'), k))).maxMinRatio).toBeLessThanOrEqual(1.01);
    }
  });

  it('improves on the greedy pass where it can (Germany, 4 territories)', () => {
    const items = itemsFrom('de');
    const greedy = balanceOf(loads(assignGreedy(items, 4))).maxMinRatio!;
    const improved = balanceOf(loads(partitionBalanced(items, 4))).maxMinRatio!;
    expect(improved).toBeLessThan(greedy);
    expect(improved).toBeLessThanOrEqual(1.005);
  });

  it('is deterministic: shuffled input gives the same territories', () => {
    const items = itemsFrom('us');
    const expected = keys(partitionBalanced(items, 4));
    for (const seed of [1, 2, 3]) expect(keys(partitionBalanced(shuffle(items, seed), 4))).toEqual(expected);
    expect(keys(partitionBalanced([...items].reverse(), 4))).toEqual(expected);
  });
});

describe('improveBySwaps properties on random inputs', () => {
  const next = random(42);
  const cases = Array.from({ length: 150 }, () => {
    const count = 5 + Math.floor(next() * 50);
    const items = Array.from({ length: count }, (_, index) => ({
      key: `s${index}`,
      // Skewed like real state counts: a few large, many small.
      weight: Math.round(1 + next() ** 3 * 2_000),
    }));
    return { items, k: 2 + Math.floor(next() * 7) };
  });

  it('never widens the spread, keeps every item exactly once, and ends locally optimal', () => {
    for (const { items, k } of cases) {
      const greedy = assignGreedy(items, k);
      const before = balanceOf(loads(greedy));
      const after = improveBySwaps(greedy.map((bin) => ({ items: [...bin.items], load: bin.load })));
      const balance = balanceOf(loads(after));

      expect(balance.max).toBeLessThanOrEqual(before.max);
      expect(balance.min).toBeGreaterThanOrEqual(before.min);
      expect(after.flatMap((bin) => bin.items.map((item) => item.key)).sort()).toEqual(items.map((item) => item.key).sort());
      after.forEach((bin) => expect(bin.load).toBe(bin.items.reduce((sum, item) => sum + item.weight, 0)));

      // No single move or swap between any two territories brings them strictly closer.
      for (const heavy of after) {
        for (const light of after) {
          const gap = heavy.load - light.load;
          if (gap <= 0) continue;
          for (const from of heavy.items) {
            for (const delta of [from.weight, ...light.items.map((to) => from.weight - to.weight)]) {
              expect(delta > 0 && delta < gap).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe('balanceOf', () => {
  it('reports max/min ratio, standard deviation and coefficient of variation', () => {
    const balance = balanceOf([90, 100, 110]);
    expect(balance.mean).toBe(100);
    expect(balance.maxMinRatio).toBeCloseTo(110 / 90);
    expect(balance.stdDev).toBeCloseTo(Math.sqrt(200 / 3));
    expect(balance.coefficientOfVariation).toBeCloseTo(Math.sqrt(200 / 3) / 100);
  });

  it('has no ratio when a territory is empty', () => {
    expect(balanceOf([10, 0]).maxMinRatio).toBeNull();
  });
});
