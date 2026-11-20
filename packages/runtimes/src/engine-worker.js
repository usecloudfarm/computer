// One worker per engine, kept warm across runs.
//
// Everything in here is deliberately plain JavaScript: the file is handed
// straight to `new Worker()`, so it must not need a build step. The host
// (worker-pool.ts) owns the lifetime - if a run blows its deadline the whole
// worker is terminated, which is the only reliable way to stop synchronous
// wasm or a tight JS loop.
import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

const engine = workerData.engine;
const MOUNT = "/work";

const format = (value) => {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const diff = (before, after) => {
  const changed = new Set();
  for (const [path, contents] of Object.entries(after)) {
    if (before[path] !== contents) changed.add(path);
  }
  for (const path of Object.keys(before)) {
    if (after[path] === undefined) changed.add(path);
  }
  return [...changed].sort();
};

// --- QuickJS ---------------------------------------------------------------

let quickjsModule;

async function runQuickJS({ code, files, entry, limits }, emit) {
  const { getQuickJS, shouldInterruptAfterDeadline } = await import("quickjs-emscripten");
  quickjsModule ??= await getQuickJS();

  const runtime = quickjsModule.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const context = runtime.newContext();

  const workspace = { ...files, [entry]: code };
  const changed = new Set();

  try {
    const consoleHandle = context.newObject();
    const method = (stream) =>
      context.newFunction(stream, (...args) => {
        emit({ type: stream, data: args.map((arg) => format(context.dump(arg))).join(" ") + "\n" });
      });
    for (const name of ["log", "info", "debug"]) {
      const fn = method("stdout");
      context.setProp(consoleHandle, name, fn);
      fn.dispose();
    }
    for (const name of ["warn", "error"]) {
      const fn = method("stderr");
      context.setProp(consoleHandle, name, fn);
      fn.dispose();
    }
    context.setProp(context.global, "console", consoleHandle);
    consoleHandle.dispose();

    const fsHandle = context.newObject();
    const define = (name, fn) => {
      const handle = context.newFunction(name, fn);
      context.setProp(fsHandle, name, handle);
      handle.dispose();
    };
    define("readFile", (pathHandle) => {
      const path = context.getString(pathHandle);
      const contents = workspace[path];
      if (contents === undefined) throw new Error(`No such file: ${path}`);
      return context.newString(contents);
    });
    define("writeFile", (pathHandle, contentsHandle) => {
      const path = context.getString(pathHandle);
      workspace[path] = context.getString(contentsHandle);
      changed.add(path);
      return context.undefined;
    });
    define("exists", (pathHandle) =>
      workspace[context.getString(pathHandle)] === undefined ? context.false : context.true,
    );
    define("list", () => {
      const array = context.newArray();
      for (const [index, path] of Object.keys(workspace).sort().entries()) {
        const value = context.newString(path);
        context.setProp(array, index, value);
        value.dispose();
      }
      return array;
    });
    context.setProp(context.global, "fs", fsHandle);
    fsHandle.dispose();

    const result = context.evalCode(code, entry);
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      const message = typeof dumped === "string" ? dumped : (dumped?.message ?? "Unknown error");
      emit({ type: "error", message, ...(dumped?.stack ? { stack: dumped.stack } : {}) });
      return { code: 1, files: workspace };
    }

    runtime.executePendingJobs();
    const value = context.dump(result.value);
    result.value.dispose();
    if (value !== undefined) emit({ type: "result", value: format(value) });
    if (changed.size > 0) emit({ type: "files", changed: [...changed].sort() });
    return { code: 0, files: workspace };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

// --- V8 (this worker's own isolate) ---------------------------------------

async function runV8({ code, files, entry }, emit) {
  const workspace = { ...files, [entry]: code };
  const changed = new Set();
  const write =
    (stream) =>
    (...args) =>
      emit({ type: stream, data: args.map(format).join(" ") + "\n" });

  const sandbox = {
    console: {
      log: write("stdout"),
      info: write("stdout"),
      debug: write("stdout"),
      warn: write("stderr"),
      error: write("stderr"),
    },
    fs: {
      readFile(path) {
        if (!(path in workspace)) throw new Error(`No such file: ${path}`);
        return workspace[path];
      },
      writeFile(path, contents) {
        workspace[path] = String(contents);
        changed.add(path);
      },
      exists: (path) => path in workspace,
      list: () => Object.keys(workspace).sort(),
    },
    // Timers and encoders only: no process, no require, no fetch.
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    Math,
    JSON,
    Date,
  };
  sandbox.globalThis = sandbox;

  try {
    const context = vm.createContext(sandbox, { name: entry });
    const result = vm.runInContext(code, context, { filename: entry });
    const settled = result instanceof Promise ? await result : result;
    if (settled !== undefined) emit({ type: "result", value: format(settled) });
    if (changed.size > 0) emit({ type: "files", changed: [...changed].sort() });
    return { code: 0, files: workspace };
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    return { code: 1, files: workspace };
  }
}

// --- CPython (Pyodide) ----------------------------------------------------

let pyodide;

async function runPython({ code, files, entry }, emit) {
  if (!pyodide) {
    const { loadPyodide } = await import("pyodide");
    pyodide = await loadPyodide();
    pyodide.FS.mkdirTree(MOUNT);
  }

  const before = { ...files, [entry]: code };
  pyodide.setStdout({ batched: (data) => emit({ type: "stdout", data: data + "\n" }) });
  pyodide.setStderr({ batched: (data) => emit({ type: "stderr", data: data + "\n" }) });

  // Mount the workspace fresh so a deleted file does not survive.
  for (const name of pyodide.FS.readdir(MOUNT)) {
    if (name === "." || name === "..") continue;
    try {
      removeRecursive(`${MOUNT}/${name}`);
    } catch {
      /* overwritten below anyway */
    }
  }
  for (const [path, contents] of Object.entries(before)) {
    const target = path.startsWith(`${MOUNT}/`) ? path : `${MOUNT}${path}`;
    pyodide.FS.mkdirTree(target.slice(0, target.lastIndexOf("/")));
    pyodide.FS.writeFile(target, contents, { encoding: "utf8" });
  }
  pyodide.FS.chdir(MOUNT);

  let exitCode = 0;
  try {
    const globals = pyodide.globals.get("dict")();
    try {
      globals.set("__name__", "__main__");
      globals.set("__file__", entry);
      await pyodide.runPythonAsync(code, { globals, filename: entry });
    } finally {
      globals.destroy();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lines = message.trim().split("\n");
    emit({ type: "error", message: lines.at(-1) ?? message, stack: message });
    exitCode = 1;
  }

  const after = collectPython(before);
  const changed = diff(before, after);
  if (changed.length > 0) emit({ type: "files", changed });
  return { code: exitCode, files: after };
}

function removeRecursive(path) {
  const stat = pyodide.FS.stat(path);
  if (pyodide.FS.isDir(stat.mode)) {
    for (const name of pyodide.FS.readdir(path)) {
      if (name === "." || name === "..") continue;
      removeRecursive(`${path}/${name}`);
    }
    pyodide.FS.rmdir(path);
    return;
  }
  pyodide.FS.unlink(path);
}

function collectPython(previous) {
  const result = {};
  const decoder = new TextDecoder();
  const walk = (dir) => {
    for (const name of pyodide.FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const path = `${dir}/${name}`;
      if (pyodide.FS.isDir(pyodide.FS.stat(path).mode)) {
        walk(path);
        continue;
      }
      try {
        result[path] = decoder.decode(pyodide.FS.readFile(path));
      } catch {
        /* not text */
      }
    }
  };
  walk(MOUNT);
  for (const [path, contents] of Object.entries(previous)) {
    if (!path.startsWith(`${MOUNT}/`) && result[path] === undefined) result[path] = contents;
  }
  return result;
}

// --- dispatch --------------------------------------------------------------

const ENGINES = { quickjs: runQuickJS, v8: runV8, cpython: runPython };

parentPort.on("message", async (request) => {
  const emit = (event) => parentPort.postMessage({ id: request.id, kind: "event", event });
  const started = Date.now();
  try {
    const run = ENGINES[engine];
    if (!run) throw new Error(`Unknown engine "${engine}"`);
    const { code, files } = await run(request, emit);
    parentPort.postMessage({
      id: request.id,
      kind: "done",
      code,
      files,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    parentPort.postMessage({
      id: request.id,
      kind: "done",
      code: 1,
      files: request.files,
      durationMs: Date.now() - started,
    });
  }
});

parentPort.postMessage({ kind: "ready" });
