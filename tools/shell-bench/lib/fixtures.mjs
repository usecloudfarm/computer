/**
 * The data every case runs over.
 *
 * Generated rather than committed, and generated from a fixed seed, so a run
 * on another machine compares against the same bytes without a 20MB directory
 * in the repository. Every generator is pure: same `n`, same string.
 */

/**
 * A 32-bit LCG — the numeric recipe from Numerical Recipes.
 *
 * Not a good random number generator and not meant to be one. It has to be
 * identical in every run on every platform, which `Math.random` is not.
 */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const LEVELS = ["INFO", "INFO", "INFO", "WARN", "ERROR", "DEBUG"];
const SERVICES = ["api", "worker", "scheduler", "gateway", "indexer"];
const REGIONS = ["emea", "amer", "apac", "latam"];
const WORDS = [
  "request",
  "timeout",
  "retry",
  "cache",
  "miss",
  "hit",
  "queue",
  "drain",
  "connect",
  "refused",
  "parse",
  "flush",
];

/** Lines of a plausible application log: the input to grep, sed and awk. */
export function logLines(n, seed = 7) {
  const next = random(seed);
  const lines = [];
  for (let index = 0; index < n; index += 1) {
    const level = LEVELS[Math.floor(next() * LEVELS.length)];
    const service = SERVICES[Math.floor(next() * SERVICES.length)];
    const latency = Math.floor(next() * 2000);
    const message = `${WORDS[Math.floor(next() * WORDS.length)]} ${WORDS[Math.floor(next() * WORDS.length)]}`;
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    lines.push(`${stamp} ${level} service=${service} latency_ms=${latency} msg="${message}"`);
  }
  return `${lines.join("\n")}\n`;
}

/** A sales table with a header: the input to cut, sort, awk and xan. */
export function salesCsv(n, seed = 11) {
  const next = random(seed);
  const rows = ["id,region,product,amount,quantity"];
  for (let index = 0; index < n; index += 1) {
    const region = REGIONS[Math.floor(next() * REGIONS.length)];
    const product = `sku-${Math.floor(next() * 50)}`;
    const amount = (next() * 1000).toFixed(2);
    const quantity = 1 + Math.floor(next() * 9);
    rows.push(`${index},${region},${product},${amount},${quantity}`);
  }
  return `${rows.join("\n")}\n`;
}

/** One JSON object per line: the input to jq's streaming path. */
export function ndjson(n, seed = 13) {
  const next = random(seed);
  const lines = [];
  for (let index = 0; index < n; index += 1) {
    lines.push(
      JSON.stringify({
        id: index,
        region: REGIONS[Math.floor(next() * REGIONS.length)],
        amount: Math.round(next() * 1000),
        active: next() > 0.5,
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One JSON array: the input to jq's whole-document path. */
export function jsonArray(n, seed = 17) {
  const next = random(seed);
  const records = [];
  for (let index = 0; index < n; index += 1) {
    records.push({
      id: index,
      region: REGIONS[Math.floor(next() * REGIONS.length)],
      amount: Math.round(next() * 1000),
      tags: [WORDS[Math.floor(next() * WORDS.length)]],
    });
  }
  return `${JSON.stringify(records)}\n`;
}

/** A word list with deliberate repeats, for `sort | uniq -c`. */
export function wordList(n, seed = 19) {
  const next = random(seed);
  const lines = [];
  for (let index = 0; index < n; index += 1) {
    lines.push(`${WORDS[Math.floor(next() * WORDS.length)]}-${Math.floor(next() * 200)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * A directory of small files.
 *
 * Both providers copy the whole workspace into the shell before every command,
 * so file *count* is a cost of its own, separate from file size. This is what
 * measures it.
 */
export function manyFiles(n, { prefix = "tree", depth = 3 } = {}) {
  const files = {};
  for (let index = 0; index < n; index += 1) {
    const directory = `${prefix}/${index % depth}`;
    files[`${directory}/file-${index}.txt`] = `file ${index}\nvalue=${index * 7}\n`;
  }
  return files;
}

/** Total bytes of a `{ path: contents }` map, for throughput figures. */
export function byteSize(files) {
  let total = 0;
  for (const contents of Object.values(files)) total += Buffer.byteLength(contents, "utf8");
  return total;
}
