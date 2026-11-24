import { afterEach, describe, expect, it } from "vitest";
import { Computer, MemoryStorage, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
import { rbash } from "./node.js";

afterEach(resetDefaults);

const workspace = async (seed: Record<string, string> = {}) => {
  setTestDefaults({ provider: rbash() });
  return new Computer({ storage: new MemoryStorage({ seed }) }).createWorkspace("tester");
};

describe("gzip and tar", () => {
  it("round-trips a file through gzip without losing a byte", async () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i}: region=emea amount=${i}`).join(
      "\n",
    );
    const ws = await workspace({ "/big.txt": body });

    const result = await ws.exec(
      "cd /data && gzip -k big.txt && gunzip -c big.txt.gz > back.txt && " +
        '[ "$(md5sum < big.txt)" = "$(md5sum < back.txt)" ] && wc -c < big.txt.gz',
    );

    expect(result.exitCode).toBe(0);
    // Compression actually happened, rather than the file passing through.
    expect(Number(result.stdout.trim())).toBeLessThan(body.length / 2);
  });

  it("creates, lists and extracts a nested tarball", async () => {
    const ws = await workspace({ "/d/a.txt": "one\n", "/d/sub/b.txt": "two\n" });

    const listed = await ws.exec("cd /data && tar -czf t.tgz d && tar -tzf t.tgz");
    await ws.exec("cd /data && mkdir -p out && tar -xzf t.tgz -C out");

    expect(listed.stdout.split("\n").filter(Boolean).toSorted()).toEqual([
      "d/",
      "d/a.txt",
      "d/sub/",
      "d/sub/b.txt",
    ]);
    expect(await ws.fs.readText("/out/d/sub/b.txt")).toBe("two\n");
  });
});

describe("rg", () => {
  it("searches recursively and groups by file, like ripgrep", async () => {
    const ws = await workspace({
      "/src/main.rs": 'fn main() {\n  println!("hello");\n}\n',
      "/docs/readme.md": "The Hello guide\n",
    });

    const result = await ws.exec("cd /data && rg hello");

    // Smart case: a lowercase pattern matches "Hello" too.
    expect(result.stdout).toBe(
      'docs/readme.md\n1:The Hello guide\n\nsrc/main.rs\n2:  println!("hello");\n',
    );
  });

  it("exits 1 when nothing matches, which scripts branch on", async () => {
    const ws = await workspace({ "/a.txt": "nothing\n" });

    expect((await ws.exec("cd /data && rg zzzz")).exitCode).toBe(1);
  });
});

describe("yq", () => {
  it("filters YAML with a jq expression and emits YAML", async () => {
    const ws = await workspace({
      "/app.yaml": "name: cloudfarm\nservices:\n  - name: web\n    port: 8787\n",
    });

    expect((await ws.exec("yq '.services[0]' /data/app.yaml")).stdout).toBe(
      "name: web\nport: 8787\n",
    );
  });

  it("emits JSON when asked", async () => {
    const ws = await workspace({ "/app.yaml": "flags:\n  debug: true\n" });

    expect((await ws.exec("yq -o=json '.flags' /data/app.yaml")).stdout).toBe(
      '{\n  "debug": true\n}\n',
    );
  });
});

describe("xan", () => {
  const CSV = 'region,rep,amount\nemea,"Ada, L",1200\namer,Alan,4300\n';

  it("selects columns and keeps quoted fields intact", async () => {
    const ws = await workspace({ "/s.csv": CSV });

    // The comma inside the quoted field has to survive both the read and
    // the write, which is the whole reason this needs a CSV reader.
    expect((await ws.exec("xan select rep /data/s.csv")).stdout).toBe('rep\n"Ada, L"\nAlan\n');
  });

  it("counts, searches and sorts", async () => {
    const ws = await workspace({ "/s.csv": CSV });

    expect((await ws.exec("xan count /data/s.csv")).stdout).toBe("2\n");
    expect((await ws.exec("xan search amer /data/s.csv")).stdout).toBe(
      "region,rep,amount\namer,Alan,4300\n",
    );
    expect((await ws.exec("xan sort -s amount --numeric -R /data/s.csv")).stdout).toBe(
      'region,rep,amount\namer,Alan,4300\nemea,"Ada, L",1200\n',
    );
  });
});

describe("html-to-markdown", () => {
  it("converts the shapes a scraped page actually has", async () => {
    const ws = await workspace({
      "/p.html":
        "<html><head><style>p{color:red}</style></head><body>" +
        "<h1>Notes</h1><p>We shipped <strong>SQLite</strong> and a <em>faster</em> shell. " +
        'See the <a href="https://example.com">docs</a>.</p>' +
        "<ul><li>Added <code>awk</code></li><li>gzip &amp; tar</li></ul></body></html>",
    });

    expect((await ws.exec("html-to-markdown /data/p.html")).stdout).toBe(
      "# Notes\n\n" +
        "We shipped **SQLite** and a *faster* shell. See the [docs](https://example.com).\n\n" +
        "- Added `awk`\n- gzip & tar\n",
    );
  });
});

describe("sqlite3", () => {
  it("creates, inserts and aggregates, and the database survives", async () => {
    const ws = await workspace();

    await ws.exec(`cd /data && sqlite3 s.db "CREATE TABLE sales(region TEXT, amount INTEGER);"`);
    await ws.exec(
      `cd /data && sqlite3 s.db "INSERT INTO sales VALUES ('emea',1200),('emea',800),('amer',4300);"`,
    );
    const grouped = await ws.exec(
      `cd /data && sqlite3 s.db "SELECT region, count(*), sum(amount) FROM sales GROUP BY region ORDER BY sum(amount) DESC;"`,
    );

    expect(grouped.stdout).toBe("amer|1|4300\nemea|2|2000\n");
    // A separate invocation: the file is the state.
    expect((await ws.exec(`cd /data && sqlite3 s.db "SELECT count(*) FROM sales;"`)).stdout).toBe(
      "3\n",
    );
  });

  it("supports HAVING on a select alias, which is what anyone writes", async () => {
    const ws = await workspace();
    await ws.exec(`cd /data && sqlite3 s.db "CREATE TABLE t(k TEXT, v INTEGER);"`);
    await ws.exec(`cd /data && sqlite3 s.db "INSERT INTO t VALUES ('a',10),('a',20),('b',5);"`);

    const result = await ws.exec(
      `cd /data && sqlite3 s.db "SELECT k, sum(v) AS total FROM t GROUP BY k HAVING total > 10;"`,
    );

    expect(result.stdout).toBe("a|30\n");
  });

  it("reports an error and a non-zero exit, rather than empty output", async () => {
    const ws = await workspace();

    const result = await ws.exec(`cd /data && sqlite3 s.db "SELECT * FROM nope;"`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no such table/);
  });
});

describe("alias, history and time", () => {
  it("expands an alias at the command position, without looping", async () => {
    const ws = await workspace({ "/d.txt": "a\na\nb\n" });

    expect((await ws.exec("alias g='grep -c'; g a /data/d.txt")).stdout).toBe("2\n");
    // `alias ls='ls'` must not recurse forever.
    expect((await ws.exec("alias ls='ls'; ls /data >/dev/null && echo survived")).stdout).toBe(
      "survived\n",
    );
  });

  it("records history", async () => {
    const ws = await workspace();

    const result = await ws.exec("echo one; history");

    // One entry per `exec`, and the entry is the whole script — including
    // the `cd` into the workspace root that the provider prepends.
    expect(result.stdout).toContain("echo one; history");
    expect(result.stdout.startsWith("one\n")).toBe(true);
  });

  it("runs the command under time", async () => {
    const ws = await workspace();

    const result = await ws.exec("time echo ran");

    // `time` is a shell keyword, so the parser takes it before command
    // dispatch ever sees it and the command runs untimed. There is no clock
    // to report anyway — `wasm32-unknown-unknown` has none, which is also
    // why `date` is a fixed string. The part a script depends on, that the
    // command still runs, holds.
    expect(result.stdout).toBe("ran\n");
    expect(result.exitCode).toBe(0);
  });
});
