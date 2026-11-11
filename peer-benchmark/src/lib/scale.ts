export interface LinearScale {
  min: number;
  max: number;
  ticks: number[];
  /** 0-100: where `value` sits along the axis, clamped to the ends. */
  position(value: number): number;
  /** True when `value` lies outside the axis and is drawn at an end. */
  isClamped(value: number): boolean;
}

const STEPS = [1, 2, 2.5, 5, 10];

/** The smallest "round" step (1, 2, 2.5 or 5 times a power of ten) giving at most `maxTicks` intervals. */
function niceStep(span: number, maxTicks: number): number {
  const raw = span / maxTicks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = STEPS.find((candidate) => candidate * power >= raw) ?? 10;
  return step * power;
}

/**
 * A linear axis over the data with round tick values. `limits` caps the axis
 * (for example growth at +200%) so one tiny team that tripled does not squash
 * every other row; values past a limit are drawn at the end and flagged.
 */
export function linearScale(
  values: readonly number[],
  options: { includeZero?: boolean; limits?: [number, number]; maxTicks?: number } = {},
): LinearScale {
  const { includeZero = true, limits = [-Infinity, Infinity], maxTicks = 5 } = options;
  const data = values.filter(Number.isFinite);
  let low = Math.max(limits[0], Math.min(...data, includeZero ? 0 : Infinity));
  let high = Math.min(limits[1], Math.max(...data, includeZero ? 0 : -Infinity));
  if (!Number.isFinite(low) || !Number.isFinite(high)) [low, high] = [0, 1];
  if (high - low < 1e-9) high = low + 0.1;

  const step = niceStep(high - low, maxTicks);
  // The small nudges absorb float error, so 0.3 / 0.1 = 2.9999... still lands on 3.
  const min = Math.max(limits[0], Math.floor(low / step + 1e-9) * step);
  const max = Math.min(limits[1], Math.ceil(high / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let tick = min; tick <= max + step / 1000; tick += step) ticks.push(Math.round(tick / step) * step);

  return {
    min,
    max,
    ticks,
    position: (value) => ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100,
    isClamped: (value) => value < min || value > max,
  };
}
