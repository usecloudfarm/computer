/**
 * Timing and the statistics the report quotes.
 *
 * Medians rather than means, because a benchmark in a JIT'd runtime has a long
 * right tail — one GC pause in fifteen iterations moves a mean and leaves a
 * median alone. The mean is still reported next to it: when the two disagree
 * the distribution is skewed, and that is worth seeing rather than hiding.
 */

/**
 * Runs `run` up to `iterations` times and returns the elapsed milliseconds of
 * each.
 *
 * `setup` is called before every iteration and is not timed, which is what
 * lets a case start from the same state each time — a fresh workspace, a fresh
 * set of fixture files — without that cost landing in the sample.
 *
 * `budgetMs` bounds the wall clock a single case may spend. Without it the
 * expensive end of the suite decides how long the whole run takes: a case
 * where one shell needs a second per iteration costs twenty seconds at ten
 * iterations, for a median no more trustworthy than the one three iterations
 * would have given. Cases that stop early report how many samples they got.
 */
export async function measure({ setup, run, iterations, warmup, budgetMs = Infinity, floor = 3 }) {
  const samples = [];
  const deadline = process.hrtime.bigint() + BigInt(Math.round(budgetMs * 1e6));
  for (let index = 0; index < warmup + iterations; index += 1) {
    const context = setup ? await setup() : undefined;
    const started = process.hrtime.bigint();
    await run(context);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    if (index >= warmup) samples.push(elapsed);
    if (samples.length >= floor && process.hrtime.bigint() > deadline) break;
  }
  return samples;
}

/** min / median / mean / p95 / spread, in milliseconds. */
export function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((total, value) => total + value, 0) / n;
  const variance =
    sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / Math.max(n - 1, 1);
  const stdev = Math.sqrt(variance);
  return {
    samples: n,
    min: sorted[0],
    median: quantile(sorted, 0.5),
    mean,
    p95: quantile(sorted, 0.95),
    max: sorted[n - 1],
    stdev,
    // Relative standard deviation: the one number that says whether a
    // difference is signal. Above ~10% treat a small gap as noise.
    rsd: mean === 0 ? 0 : stdev / mean,
  };
}

/** Linear-interpolated quantile over an already-sorted array. */
export function quantile(sorted, fraction) {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * The geometric mean, for averaging ratios.
 *
 * An arithmetic mean of speedups is wrong in a way that always flatters the
 * winner: 10x and 0.1x average to 5.05x rather than to 1x. The geometric mean
 * treats "twice as fast" and "half as fast" as equal and opposite, which is
 * what a summary row across unrelated workloads has to do.
 */
export function geomean(values) {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length === 0) return Number.NaN;
  const logs = usable.reduce((total, value) => total + Math.log(value), 0);
  return Math.exp(logs / usable.length);
}
