// The package used the way a consumer uses it: a shell on its own, with no
// Computer anywhere. `@cloudfarm/rbash-sandbox` has its own suite for the
// provider; if an import of core ever creeps in here, this file stops
// compiling, which is the point of keeping the two separate.
import { describe, expect, it } from "vitest";
import { createShell, loadShell } from "./node.js";

describe("@cloudfarm/rbash", () => {
  it("runs a command and returns its output", () => {
    const sh = createShell();

    expect(sh.exec("echo hello")).toMatchObject({ stdout: "hello\n", exitCode: 0 });
  });

  it("reports a non-zero exit instead of throwing", () => {
    const sh = createShell();

    expect(sh.exec("exit 3")).toMatchObject({ exitCode: 3 });
  });

  it("reads back a file it wrote", () => {
    const sh = createShell();
    sh.writeFile("data.json", '[{"n":1},{"n":5}]');

    expect(sh.exec("jq '[.[].n] | add' data.json").stdout.trim()).toBe("6");
    expect(sh.readFile("data.json")).toBe('[{"n":1},{"n":5}]');
  });

  it("supports pipelines, redirection and control flow", () => {
    const sh = createShell();
    sh.writeFile("words.txt", "pear\napple\nbanana\napple\n");

    const result = sh.exec("sort words.txt | uniq -c | sort -rn | head -1 > top.txt; cat top.txt");

    expect(result.stdout.trim()).toMatch(/2\s+apple/);
  });

  it("keeps bytes intact through the byte-exact pair", () => {
    // A string round trip would mangle this: it is not valid UTF-8, which is
    // true of every gzip stream and every tarball.
    const sh = createShell();
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x42]);

    sh.writeFileBytes("blob.bin", bytes);

    expect(sh.readFileBytes("blob.bin")).toEqual(bytes);
  });

  it("gives each shell its own filesystem", () => {
    const first = createShell();
    first.writeFile("secret.txt", "from the first");

    const second = createShell();

    expect(second.readFile("secret.txt")).toBeUndefined();
  });

  it("touches nothing outside itself", () => {
    // The whole premise: no container, no subprocess, no host disk. If this
    // ever reads the real filesystem, the sandbox claim is false.
    const sh = createShell();

    expect(sh.exec("cat /etc/passwd").exitCode).not.toBe(0);
  });

  it("has no curl until a fetch is supplied", async () => {
    const sh = createShell();

    expect(sh.exec("curl -s https://example.com").exitCode).not.toBe(0);
  });

  it("reaches the network through the fetch it is given", async () => {
    const sh = createShell();
    const seen: string[] = [];
    sh.setFetch(async (request) => {
      seen.push(request.url);
      return { status: 200, headers: {}, body: "hello from the host" };
    });

    // `execAsync`, not `exec`: the interpreter is synchronous, so the sync
    // path has nowhere to await and `curl` does not exist there.
    const result = await sh.execAsync("curl -s https://example.com");

    expect(result.stdout).toContain("hello from the host");
    expect(seen).toEqual(["https://example.com"]);
  });

  it("lists the commands this build carries", () => {
    const commands = loadShell().commands();

    // Spot checks rather than a count: the list grows, and a number here
    // would fail on the next command added rather than on a real regression.
    expect(commands).toEqual(expect.arrayContaining(["awk", "jq", "sed", "tar", "sqlite3"]));
    // Absences are load-bearing — there is no process to spawn.
    expect(commands).not.toContain("npm");
    expect(commands).not.toContain("python");
  });
});
