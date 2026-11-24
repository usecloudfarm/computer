import { afterEach, describe, expect, it } from "vitest";
import { Computer, MemoryStorage, resetDefaults, setTestDefaults } from "@cloudfarm/computer";
import { rbash } from "./node.js";

afterEach(resetDefaults);

const workspace = async (seed: Record<string, string> = {}) => {
  setTestDefaults({ provider: rbash() });
  return new Computer({ storage: new MemoryStorage({ seed }) }).createWorkspace("tester");
};

const SALES = "region,rep,amount\nemea,ada,1200\nemea,grace,800\namer,alan,4300\napac,joan,150\n";

describe("awk", () => {
  it("totals a column, which is the thing a model reaches for first", async () => {
    const ws = await workspace({ "/sales.csv": SALES });

    const result = await ws.exec("awk -F, 'NR>1 {s+=$3} END {print s}' /data/sales.csv");

    expect(result.stdout.trim()).toBe("6450");
    expect(result.exitCode).toBe(0);
  });

  it("groups by a key", async () => {
    const ws = await workspace({ "/sales.csv": SALES });

    const result = await ws.exec(
      "awk -F, 'NR>1 {t[$1]+=$3} END {for (k in t) print k, t[k]}' /data/sales.csv",
    );

    expect(result.stdout).toBe("amer 4300\napac 150\nemea 2000\n");
  });

  it("formats with printf, patterns and builtins", async () => {
    const ws = await workspace({ "/sales.csv": SALES });

    const result = await ws.exec(
      `awk -F, '/emea/ {printf "%-6s %6.2f\\n", toupper($2), $3}' /data/sales.csv`,
    );

    expect(result.stdout).toBe("ADA    1200.00\nGRACE  800.00\n");
  });

  it("compares a field as a number but a constant as a string", async () => {
    const ws = await workspace();

    // POSIX's numeric-string rule. Collapsing the two gets one of these wrong.
    const result = await ws.exec(`awk 'BEGIN {print (10 > 9), ("10" < "9")}'`);

    expect(result.stdout.trim()).toBe("1 1");
  });

  it("bounds a runaway program rather than hanging", async () => {
    const ws = await workspace();

    const result = await ws.exec(`awk 'BEGIN {while (1) x++}'`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/limit/i);
  });
});

describe("the rest of the coreutils", () => {
  const cases: [string, string, string][] = [
    ["base64", "printf 'hello world' | base64", "aGVsbG8gd29ybGQ=\n"],
    ["base64 -d", "printf 'aGVsbG8=' | base64 -d", "hello"],
    ["md5sum", "printf 'hello' | md5sum", "5d41402abc4b2a76b9719d911017c592  -\n"],
    [
      "sha256sum",
      "printf 'hello' | sha256sum",
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  -\n",
    ],
    ["expr", "expr 3 + 4 '*' 2", "11\n"],
    ["fold", "printf 'abcdefghij\\n' | fold -w 3", "abc\ndef\nghi\nj\n"],
    ["expand", "printf 'a\\tb\\n' | expand -t 4", "a   b\n"],
    ["column -t", "printf 'a bb\\nccc d\\n' | column -t", "a    bb\nccc  d\n"],
    ["which", "which grep", "/usr/bin/grep\n"],
    ["true", "true && echo yes", "yes\n"],
    ["yes", "yes ok | head -2", "ok\nok\n"],
    ["timeout", "timeout 5 echo ran", "ran\n"],
  ];

  for (const [name, command, expected] of cases) {
    it(name, async () => {
      const ws = await workspace();
      expect((await ws.exec(command)).stdout).toBe(expected);
    });
  }

  it("diff reports hunks the way GNU does", async () => {
    const ws = await workspace({ "/a.txt": "b\na\nc\n", "/b.txt": "a\nc\nd\n" });

    const result = await ws.exec("diff /data/a.txt /data/b.txt");

    // The line numbers are the point: a list of < and > lines is not a diff
    // anyone can apply.
    expect(result.stdout).toBe("1d0\n< b\n3a3\n> d\n");
    expect(result.exitCode).toBe(1);
  });

  it("comm splits two sorted files into three columns", async () => {
    const ws = await workspace({ "/x.txt": "a\nb\nc\n", "/y.txt": "a\nc\nd\n" });

    expect((await ws.exec("comm -12 /data/x.txt /data/y.txt")).stdout).toBe("a\nc\n");
  });

  it("join matches on a shared key", async () => {
    const ws = await workspace({ "/j1.txt": "1 alpha\n2 beta\n", "/j2.txt": "1 x\n2 y\n" });

    expect((await ws.exec("join /data/j1.txt /data/j2.txt")).stdout).toBe("1 alpha x\n2 beta y\n");
  });

  it("split writes numbered parts back to the workspace", async () => {
    const ws = await workspace({ "/s.txt": "a\nb\nc\nd\n" });

    await ws.exec("cd /data && split -l 2 s.txt part");

    expect(await ws.fs.readText("/partaa")).toBe("a\nb\n");
    expect(await ws.fs.readText("/partab")).toBe("c\nd\n");
  });

  it("mktemp makes a file that is actually there", async () => {
    const ws = await workspace();

    const result = await ws.exec('f=$(mktemp) && test -f "$f" && echo "$f"');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\/tmp\/tmp\./);
  });
});
