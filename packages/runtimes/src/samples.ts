import type { CodeSample, FileMap } from "@unsandbox/sandbox-core";

/** Files every workspace starts with, so samples have something to read. */
export const STARTER_FILES: FileMap = {
  "/work/README.md":
    "# unsandbox playground\n\n" +
    "Files here are shared across every runtime. Each engine mounts this\n" +
    "workspace, runs your code, and whatever it writes back shows up in the\n" +
    "explorer.\n",
  "/work/data/people.csv":
    "name,role,city\nada,engineer,london\ngrace,admiral,new york\nalan,theorist,cambridge\n",
  "/work/data/config.json": JSON.stringify({ greeting: "hello", retries: 3 }, null, 2) + "\n",
};

const jsSamples: CodeSample[] = [
  {
    id: "hello",
    title: "Hello + return value",
    description: "Console output and the value of the last expression.",
    code: `console.log("hello from", typeof fs === "object" ? "a sandbox" : "somewhere");

const squares = [1, 2, 3, 4].map((n) => n * n);
console.log("squares:", squares.join(", "));

({ squares, sum: squares.reduce((a, b) => a + b, 0) });
`,
  },
  {
    id: "vfs",
    title: "Read and write the workspace",
    description: "Reads a mounted file, writes a new one, and lists the workspace.",
    code: `const config = JSON.parse(fs.readFile("/work/data/config.json"));
console.log("greeting:", config.greeting);

const rows = fs.readFile("/work/data/people.csv").trim().split("\\n").slice(1);
const names = rows.map((row) => row.split(",")[0]);

fs.writeFile("/work/out/names.txt", names.join("\\n") + "\\n");
console.log("wrote /work/out/names.txt");
console.log("workspace now holds:");
for (const path of fs.list()) console.log("  " + path);

names.length;
`,
  },
  {
    id: "limits",
    title: "Hit the time limit",
    description: "An infinite loop, to see how each engine stops runaway code.",
    code: `console.log("looping forever - the runtime should stop this");
let n = 0;
while (true) n++;
`,
  },
  {
    id: "error",
    title: "Throw an error",
    description: "How uncaught errors are reported back.",
    code: `function parse(input) {
  return JSON.parse(input);
}

console.log("about to fail");
parse("{ not json }");
`,
  },
];

const pythonSamples: CodeSample[] = [
  {
    id: "hello",
    title: "Hello + stdlib",
    description: "Proves it is really CPython, with the real standard library.",
    code: `import sys, platform, json

print("python", sys.version.split()[0], "on", platform.machine())
print("stdlib json works:", json.dumps({"ok": True}))

squares = [n * n for n in range(1, 5)]
print("squares:", squares)
`,
  },
  {
    id: "vfs",
    title: "Read and write the workspace",
    description: "csv from the mounted workspace, written back as JSON.",
    code: `import csv, json, pathlib

rows = list(csv.DictReader(open("/work/data/people.csv")))
print(f"read {len(rows)} rows")
for row in rows:
    print(" ", row["name"], "->", row["role"])

out = pathlib.Path("/work/out/people.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(rows, indent=2) + "\\n")
print("wrote", out)
`,
  },
  {
    id: "dataclass",
    title: "Modern Python features",
    description: "Dataclasses, pattern matching and f-strings.",
    code: `from dataclasses import dataclass

@dataclass
class Shape:
    kind: str
    size: float

def describe(shape: Shape) -> str:
    match shape:
        case Shape(kind="circle", size=s):
            return f"circle of radius {s}"
        case Shape(kind=k, size=s) if s > 10:
            return f"big {k} ({s})"
        case Shape(kind=k):
            return f"a {k}"

for shape in [Shape("circle", 2), Shape("square", 42), Shape("blob", 1)]:
    print(describe(shape))
`,
  },
  {
    id: "error",
    title: "Traceback",
    description: "An uncaught exception, with the real CPython traceback.",
    code: `def divide(a, b):
    return a / b

print("about to divide by zero")
divide(1, 0)
`,
  },
];

const shellSamples: CodeSample[] = [
  {
    id: "hello",
    title: "Hello + pipelines",
    description: "Basic commands, pipes and redirection.",
    code: `echo "hello from the shell"
echo
echo "the workspace is the working directory:"
ls -la .

echo
echo "names from the csv:"
tail -n +2 data/people.csv | cut -d, -f1 | sort
`,
  },
  {
    id: "vfs",
    title: "Write back to the workspace",
    description: "Creates files that show up in the explorer afterwards.",
    code: `mkdir -p out

tail -n +2 data/people.csv | cut -d, -f1 > out/names.txt
wc -l < out/names.txt | tr -d ' ' > out/count.txt

echo "wrote:"
cat out/names.txt
echo "count: $(cat out/count.txt)"
`,
  },
  {
    id: "control-flow",
    title: "Loops and conditionals",
    description: "Shell control flow, for comparing the two shell engines.",
    code: `for name in ada grace alan; do
  if [ "$name" = "grace" ]; then
    echo "$name: found the admiral"
  else
    echo "$name: engineer or theorist"
  fi
done

i=0
while [ $i -lt 3 ]; do
  echo "tick $i"
  i=$((i + 1))
done
`,
  },
  {
    id: "exit-code",
    title: "Failure and exit codes",
    description: "A failing command, and what the runtime reports.",
    code: `echo "this works"
ls /definitely/not/here
echo "exit code was: $?"
exit 3
`,
  },
];

/** Samples per runtime id. The UI reads this to populate its picker. */
export const SAMPLES: Record<string, CodeSample[]> = {
  quickjs: jsSamples,
  v8: jsSamples,
  cpython: pythonSamples,
  bash: shellSamples,
  dash: shellSamples,
};

export function samplesFor(runtimeId: string): CodeSample[] {
  return SAMPLES[runtimeId] ?? [];
}
