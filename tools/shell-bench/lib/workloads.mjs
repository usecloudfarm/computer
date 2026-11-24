/**
 * What gets run, and what the right answer is.
 *
 * Every case carries an `expect` computed in JavaScript from the same fixture
 * the shell sees, so a case that silently does nothing — a missing command, a
 * regex dialect that matches zero lines, a numeric overflow — fails the run
 * instead of posting a very fast time. A benchmark without that check measures
 * how quickly each shell can be wrong.
 *
 * Sizes are chosen so the slower side lands in tens to hundreds of
 * milliseconds: long enough that the clock and the scheduler do not dominate,
 * short enough that a full run is a couple of minutes.
 */

import {
  byteSize,
  jsonArray,
  logLines,
  manyFiles,
  ndjson,
  salesCsv,
  wordList,
} from "./fixtures.mjs";

/** Lines of `text` containing `needle`. */
const count = (text, needle) => text.split("\n").filter((line) => line.includes(needle)).length;

/** `stdout` is exactly this number, whatever padding the shell added. */
const number = (value) => (stdout) => Number(stdout.trim()) === value;

/** `stdout` is exactly this text, ignoring leading and trailing space. */
const text = (value) => (stdout) => stdout.trim() === value.trim();

const LOG_SIZES = [1_000, 10_000, 50_000];

/**
 * @returns {Array<{
 *   id: string, group: string, script: string,
 *   files: Record<string, string>, expect: (stdout: string) => boolean,
 *   heavy?: boolean, note?: string,
 * }>}
 */
export function workloads() {
  const cases = [];
  const add = (entry) => {
    cases.push({ heavy: false, ...entry, bytes: byteSize(entry.files) });
  };

  // --- Startup: what a command costs before it has done anything ----------
  //
  // Both providers build a fresh interpreter per command, so this is a floor
  // under every number below it, and at the provider layer it is also where
  // the workspace snapshot shows up.

  add({
    id: "startup/noop",
    group: "startup",
    script: "true",
    files: {},
    expect: text(""),
    note: "interpreter construction, nothing else",
  });
  add({
    id: "startup/echo",
    group: "startup",
    script: "echo hello",
    files: {},
    expect: text("hello"),
  });
  add({
    id: "startup/echo-200-files",
    group: "startup",
    script: "echo hello",
    files: manyFiles(200),
    expect: text("hello"),
    note: "same command, 200 files to carry in first",
  });

  // --- Filesystem --------------------------------------------------------

  add({
    id: "fs/write-100-files",
    group: "filesystem",
    script: 'for i in $(seq 1 100); do echo "line $i" > out-$i.txt; done; ls out-*.txt | wc -l',
    files: {},
    expect: number(100),
  });
  add({
    id: "fs/read-200-files",
    group: "filesystem",
    script: "cat tree/*/*.txt | wc -l",
    files: manyFiles(200),
    expect: number(400),
  });
  add({
    id: "fs/find-200-files",
    group: "filesystem",
    script: "find tree -name '*.txt' | wc -l",
    files: manyFiles(200),
    expect: number(200),
  });
  add({
    id: "fs/copy-tree",
    group: "filesystem",
    script: "cp -r tree copy && find copy -type f | wc -l",
    files: manyFiles(100),
    expect: number(100),
  });

  // --- Search ------------------------------------------------------------

  for (const size of LOG_SIZES) {
    const log = logLines(size);
    const errors = count(log, " ERROR ");
    add({
      id: `grep/fixed-${label(size)}`,
      group: "search",
      script: "grep -c ERROR app.log",
      files: { "app.log": log },
      expect: number(errors),
      heavy: size > 10_000,
    });
    add({
      id: `grep/regex-${label(size)}`,
      group: "search",
      script: "grep -cE 'latency_ms=1[0-9]{3}' app.log",
      files: { "app.log": log },
      expect: number(
        log.split("\n").filter((line) => /latency_ms=1[0-9]{3}(\s|$)/.test(line)).length,
      ),
      heavy: size > 10_000,
    });
    add({
      id: `grep/invert-${label(size)}`,
      group: "search",
      script: "grep -v INFO app.log | wc -l",
      files: { "app.log": log },
      expect: number(size - count(log, " INFO ")),
      heavy: size > 10_000,
    });
  }

  // --- Transform ---------------------------------------------------------

  for (const size of [10_000, 50_000]) {
    const log = logLines(size);
    add({
      id: `sed/substitute-${label(size)}`,
      group: "transform",
      script: "sed 's/latency_ms=[0-9]*/latency_ms=X/' app.log | grep -c 'latency_ms=X'",
      files: { "app.log": log },
      expect: number(size),
      heavy: size > 10_000,
    });
    add({
      id: `tr/uppercase-${label(size)}`,
      group: "transform",
      script: "tr 'a-z' 'A-Z' < app.log | grep -c 'LATENCY_MS='",
      files: { "app.log": log },
      expect: number(size),
      heavy: size > 10_000,
    });
  }

  for (const size of [10_000, 50_000]) {
    const csv = salesCsv(size);
    const rows = csv.trim().split("\n").slice(1);
    const total = rows.reduce((sum, row) => sum + Number(row.split(",")[3]), 0);
    add({
      id: `awk/field-sum-${label(size)}`,
      group: "transform",
      script: "awk -F, 'NR>1 {s+=$4} END {printf \"%.0f\\n\", s}' sales.csv",
      files: { "sales.csv": csv },
      expect: number(Math.round(total)),
      heavy: size > 10_000,
    });

    const byRegion = new Map();
    for (const row of rows) {
      const [, region, , amount] = row.split(",");
      byRegion.set(region, (byRegion.get(region) ?? 0) + Number(amount));
    }
    const expected = [...byRegion.entries()]
      .map(([region, sum]) => `${region} ${Math.round(sum)}`)
      .toSorted()
      .join("\n");
    add({
      id: `awk/group-by-${label(size)}`,
      group: "transform",
      script:
        "awk -F, 'NR>1 {s[$2]+=$4} END {for (k in s) printf \"%s %.0f\\n\", k, s[k]}' " +
        "sales.csv | sort",
      files: { "sales.csv": csv },
      expect: text(expected),
      heavy: size > 10_000,
      note: "associative arrays, the part of awk that is a real interpreter",
    });
    add({
      id: `cut/project-${label(size)}`,
      group: "transform",
      script: "cut -d, -f2,4 sales.csv | tail -n +2 | wc -l",
      files: { "sales.csv": csv },
      expect: number(size),
      heavy: size > 10_000,
    });
  }

  // --- Sorting and pipelines ---------------------------------------------

  for (const size of [20_000, 100_000]) {
    const words = wordList(size);
    const tally = new Map();
    for (const word of words.trim().split("\n")) tally.set(word, (tally.get(word) ?? 0) + 1);
    const third = [...tally.values()].toSorted((a, b) => b - a)[2];
    add({
      id: `pipeline/top-words-${label(size)}`,
      group: "pipeline",
      // `tr -s` because `uniq -c` pads its counts differently in the two
      // shells — a real difference, recorded in the parity table, and not one
      // this case is trying to measure.
      script: "sort words.txt | uniq -c | sort -rn | head -3 | tr -s ' ' | sed 's/^ //'",
      files: { "words.txt": words },
      // Counts are checked, order among equal counts is not: several words
      // tie at the top and `sort -rn` is free to break the tie either way.
      expect: (stdout) => {
        const rows = stdout.trim().split("\n");
        return (
          rows.length === 3 &&
          rows.every((row) => {
            const [times, word] = row.trim().split(/\s+/);
            return tally.get(word) === Number(times) && Number(times) >= third;
          })
        );
      },
      heavy: size > 20_000,
    });
  }

  const report = logLines(20_000);
  const services = new Map();
  for (const line of report.trim().split("\n")) {
    if (!line.includes(" ERROR ")) continue;
    const service = /service=(\w+)/.exec(line)?.[1];
    if (service) services.set(service, (services.get(service) ?? 0) + 1);
  }
  add({
    id: "pipeline/error-report-20k",
    group: "pipeline",
    script:
      "grep ERROR app.log | sed 's/.*service=\\([a-z]*\\).*/\\1/' | sort | uniq -c | " +
      "sort -rn | head -3 | tr -s ' ' | sed 's/^ //'",
    files: { "app.log": report },
    expect: text(
      [...services.entries()]
        .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([service, n]) => `${n} ${service}`)
        .join("\n"),
    ),
    note: "the shape of an actual agent command: grep, extract, tally, top-n",
  });

  // --- JSON --------------------------------------------------------------

  const array = jsonArray(5_000);
  const parsed = JSON.parse(array);
  add({
    id: "jq/select-sum-5k",
    group: "json",
    script: "jq '[.[] | select(.amount > 500) | .amount] | add' data.json",
    files: { "data.json": array },
    expect: number(
      parsed.filter((row) => row.amount > 500).reduce((sum, row) => sum + row.amount, 0),
    ),
  });
  add({
    id: "jq/group-count-5k",
    group: "json",
    script:
      "jq -r 'group_by(.region) | map(\"\\(.[0].region) \\(length)\") | .[]' data.json | sort",
    files: { "data.json": array },
    expect: text(
      [...countBy(parsed, (row) => row.region)]
        .map(([region, n]) => `${region} ${n}`)
        .toSorted()
        .join("\n"),
    ),
  });

  const lines = ndjson(5_000);
  add({
    id: "jq/ndjson-sum-5k",
    group: "json",
    script: "jq -s 'map(.amount) | add' records.ndjson",
    files: { "records.ndjson": lines },
    expect: number(
      lines
        .trim()
        .split("\n")
        .reduce((sum, line) => sum + JSON.parse(line).amount, 0),
    ),
  });

  // --- Control flow ------------------------------------------------------
  //
  // No coreutil does the work here: it is the interpreter's own loop,
  // arithmetic, function call and parameter expansion.

  add({
    id: "loop/for-arith-1k",
    group: "control flow",
    script: "total=0; for i in $(seq 1 1000); do total=$((total+i)); done; echo $total",
    files: {},
    expect: number(500_500),
  });
  add({
    id: "loop/while-read-5k",
    group: "control flow",
    script: "n=0; while read -r line; do n=$((n+1)); done < app.log; echo $n",
    files: { "app.log": logLines(5_000) },
    expect: number(5_000),
  });
  add({
    id: "loop/function-calls-500",
    group: "control flow",
    script:
      "double() { echo $(( $1 * 2 )); }; total=0; " +
      "for i in $(seq 1 500); do v=$(double $i); total=$((total+v)); done; echo $total",
    files: {},
    expect: number(500 * 501),
    note: "a function and a command substitution per iteration",
  });
  add({
    id: "loop/arith-cmdsub-100",
    group: "control flow",
    // The same thing written the way a model usually writes it, with the
    // substitution inside the arithmetic. Kept as its own case because the
    // two shells do not agree on it: just-bash evaluates
    // `$((total + $(cmd)))` to 0, which the check below catches.
    script:
      "double() { echo $(( $1 * 2 )); }; total=0; " +
      "for i in $(seq 1 100); do total=$((total + $(double $i))); done; echo $total",
    files: {},
    expect: number(100 * 101),
    note: "command substitution inside $(( )) — just-bash answers 0",
  });
  // Parameter expansion, split by kind, because the two shells are not
  // uniformly faster or slower here: the glob-matching forms (`##` and
  // `case`) are where rbash loses, and the plain ones are where it wins.
  add({
    id: "string/strip-prefix-2k",
    group: "control flow",
    script:
      'last=; for i in $(seq 1 2000); do s="path/to/file-$i.txt"; last="${s##*/}"; done; ' +
      "echo $last",
    files: {},
    expect: text("file-2000.txt"),
    note: "${var##*/} — longest-prefix glob",
  });
  add({
    id: "string/strip-suffix-2k",
    group: "control flow",
    script: 'last=; for i in $(seq 1 2000); do s="file-$i.txt"; last="${s%.txt}"; done; echo $last',
    files: {},
    expect: text("file-2000"),
    note: "${var%.txt} — fixed suffix",
  });
  add({
    id: "string/replace-all-2k",
    group: "control flow",
    script: 'last=; for i in $(seq 1 2000); do s="a-b-c-$i"; last="${s//-/_}"; done; echo $last',
    files: {},
    expect: text("a_b_c_2000"),
  });
  add({
    id: "glob/case-match-2k",
    group: "control flow",
    script:
      'hits=0; for i in $(seq 1 2000); do case "file-$i.txt" in file-*.txt) hits=$((hits+1));; ' +
      "esac; done; echo $hits",
    files: {},
    expect: number(2_000),
    note: "pattern matching in `case`",
  });
  add({
    id: "loop/subshell-pipeline-200",
    group: "control flow",
    script: 'n=0; for i in $(seq 1 200); do n=$((n + $(echo "a b c" | wc -w))); done; echo $n',
    files: {},
    expect: number(600),
    note: "a subshell and a pipeline per iteration: process setup, 200 times",
  });

  // --- Heavier built-ins -------------------------------------------------
  //
  // The commands past coreutils. Both shells claim most of them; a case a
  // shell does not have is reported as a gap rather than as a slow time.

  const archive = logLines(5_000);
  add({
    id: "gzip/round-trip-5k",
    group: "built-ins",
    script:
      "gzip -k app.log && gunzip -c app.log.gz > back.log && " +
      'if [ "$(md5sum < app.log)" = "$(md5sum < back.log)" ]; then echo same; fi',
    files: { "app.log": archive },
    expect: text("same"),
  });
  add({
    id: "tar/create-extract",
    group: "built-ins",
    script:
      "tar -czf tree.tgz tree && mkdir -p out && tar -xzf tree.tgz -C out && find out -type f | wc -l",
    files: manyFiles(100),
    expect: number(100),
  });
  add({
    id: "rg/recursive-10k",
    group: "built-ins",
    // `rg -c` prints `app.log:145` in one shell and `145` in the other, which
    // is a formatting difference rather than a capability one.
    script: "rg -c ERROR app.log | sed 's/.*://'",
    files: { "app.log": logLines(10_000) },
    expect: number(count(logLines(10_000), " ERROR ")),
  });
  add({
    id: "md5sum/checksum-50k",
    group: "built-ins",
    script: "md5sum < app.log | cut -d' ' -f1 | wc -c",
    files: { "app.log": logLines(50_000) },
    // 32 hex characters and a newline, whichever digest it is.
    expect: number(33),
  });
  add({
    id: "base64/round-trip-50k",
    group: "built-ins",
    script: "base64 app.log > b64.txt && base64 -d b64.txt | wc -l",
    files: { "app.log": logLines(50_000) },
    expect: number(50_000),
  });
  add({
    id: "diff/two-files-5k",
    group: "built-ins",
    script: "sed 's/ERROR/FATAL/' app.log > changed.log; diff app.log changed.log | grep -c '^<'",
    files: { "app.log": logLines(5_000) },
    expect: number(count(logLines(5_000), " ERROR ")),
  });
  add({
    id: "yq/filter",
    group: "built-ins",
    script: "yq '.services[0].port' app.yaml",
    files: {
      "app.yaml":
        "name: cloudfarm\nservices:\n  - name: web\n    port: 8787\n  - name: api\n    port: 9000\n",
    },
    expect: number(8787),
  });
  add({
    id: "sqlite3/create-query",
    group: "built-ins",
    // Deliberately small. The point is whether `sqlite3` is there at all:
    // just-bash's loads its engine in a worker, which does not start under a
    // plain `node` process, and rbash's is a parser that does not take
    // `insert … select`. Neither gap shows up in a list of command names.
    script:
      'sqlite3 db.sqlite "create table t(x int); insert into t values (1),(2),(3); ' +
      'select count(*) from t;"',
    files: {},
    expect: number(3),
  });
  add({
    id: "xan/csv-count-10k",
    group: "built-ins",
    script: "xan count sales.csv",
    files: { "sales.csv": salesCsv(10_000) },
    expect: number(10_000),
  });

  return cases;
}

/** 1000 → 1k, 50000 → 50k. */
function label(size) {
  return size % 1000 === 0 ? `${size / 1000}k` : String(size);
}

function countBy(rows, key) {
  const tally = new Map();
  for (const row of rows) {
    const value = key(row);
    tally.set(value, (tally.get(value) ?? 0) + 1);
  }
  return tally;
}
