/**
 * Spec loading and validation.
 *
 * The generator's whole claim is that an integration is predictable to add, so
 * every mistake a spec can make is caught here, named, and reported with the
 * fix — before a single line is emitted. A spec that passes this file produces
 * a package that passes `pnpm check`; that is the contract.
 */

import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SPECS = fileURLToPath(new URL("../specs/", import.meta.url));

const APP_ID = /^[a-z][a-z0-9-]*$/;
const MEMBER = /^[a-z][a-zA-Z0-9]*$/;
const SIDE_EFFECTS = new Set(["read", "write", "destructive"]);
const AUTH_KINDS = new Set(["apiKey", "basic", "none"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function listSpecIds() {
  const entries = await readdir(SPECS);
  return entries
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => entry.slice(0, -".mjs".length))
    .sort();
}

export async function loadSpec(id) {
  const file = path.join(SPECS, `${id}.mjs`);
  const module = await import(file);
  const spec = module.default;
  if (!spec) throw new Error(`${id}.mjs does not default-export a spec.`);
  if (spec.id !== id) {
    throw new Error(`${id}.mjs declares id "${spec.id}"; the file name must match the id.`);
  }
  return normalize(spec);
}

function fail(message) {
  throw new Error(message);
}

/** `{site}` placeholders in a base URL or host, which become options. */
export function placeholders(text) {
  return [...String(text).matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]);
}

function normalize(spec) {
  const where = `spec ${spec.id}`;
  if (!APP_ID.test(spec.id ?? "")) fail(`${where}: id must match ${APP_ID}.`);
  for (const key of ["name", "description", "npmDescription", "baseUrl", "credentials"]) {
    if (!spec[key]) fail(`${where}: "${key}" is required.`);
  }
  if (!Array.isArray(spec.actions) || spec.actions.length === 0) {
    fail(`${where}: at least one action is required — an app with none is unreachable.`);
  }

  const auth = spec.auth ?? { kind: "none" };
  if (!AUTH_KINDS.has(auth.kind)) {
    fail(`${where}: auth.kind must be one of ${[...AUTH_KINDS].join(", ")}. OAuth is deliberately
not generated: the flow is not implemented in core, so a generated OAuth app would
look finished and not be.`);
  }

  const options = { ...(spec.options ?? {}) };
  for (const source of [spec.baseUrl, ...(spec.allowedHosts ?? [])]) {
    for (const name of placeholders(source)) {
      if (!options[name]) {
        fail(`${where}: "${source}" interpolates {${name}}, so options.${name} must be declared.`);
      }
    }
  }

  const hosts = spec.allowedHosts ?? [new URL(spec.baseUrl.replace(/\{\w+\}/g, "x")).host];
  const templated =
    placeholders(spec.baseUrl).length > 0 || hosts.some((h) => placeholders(h).length > 0);

  const actions = spec.actions.map((action) => normalizeAction(action, spec.id));
  const names = new Set();
  for (const action of actions) {
    if (names.has(action.name)) fail(`${where}: two actions are called "${action.name}".`);
    names.add(action.name);
  }

  return {
    ...spec,
    auth,
    options,
    allowedHosts: hosts,
    templated,
    actions,
    dirName: spec.dirName ?? spec.id,
    packageName: spec.packageName ?? `@cloudfarm/${spec.id}`,
    constName: spec.id.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()),
    notes: spec.notes ?? [],
    headers: spec.headers ?? {},
    docsUrl: spec.docsUrl ?? null,
    validate: spec.validate ?? null,
  };
}

function normalizeAction(action, appId) {
  const where = `spec ${appId}.${action.name}`;
  if (!MEMBER.test(action.name ?? "")) fail(`${where}: action names must match ${MEMBER}.`);
  if (!action.summary) fail(`${where}: "summary" is required — it is the prompt text.`);
  if (!Array.isArray(action.useCases) || action.useCases.length === 0) {
    fail(`${where}: "useCases" drives search ranking; an action without any is unreachable.`);
  }
  if (!SIDE_EFFECTS.has(action.sideEffects)) {
    fail(`${where}: sideEffects must be one of ${[...SIDE_EFFECTS].join(", ")}.`);
  }
  if (!action.output) fail(`${where}: "output" is required.`);

  const input = action.input ?? {};
  for (const [name, field] of Object.entries(input)) {
    if (!MEMBER.test(name)) fail(`${where}: input "${name}" must match ${MEMBER}.`);
    if (field.type === "enum" && !Array.isArray(field.values)) {
      fail(`${where}: input "${name}" is an enum and needs "values".`);
    }
  }

  if (action.handler) {
    if (typeof action.handler !== "string") {
      fail(`${where}: "handler" is the raw-source escape hatch and must be a string.`);
    }
  } else {
    const request = action.request;
    if (!request) fail(`${where}: "request" is required unless a raw "handler" is given.`);
    if (request.graphql) {
      if (!request.graphql.query) fail(`${where}: request.graphql needs a "query".`);
    } else {
      if (!METHODS.has(request.method)) {
        fail(`${where}: request.method must be one of ${[...METHODS].join(", ")}.`);
      }
      if (typeof request.path !== "string") fail(`${where}: request.path is required.`);
      if (request.body && request.form) {
        fail(`${where}: an action sends either "body" (JSON) or "form" (urlencoded), not both.`);
      }
      if (request.form && request.method === "GET") {
        fail(`${where}: a GET cannot carry a form body.`);
      }
    }
  }

  // Tests are not optional. A generated integration nobody exercised is a
  // guess about an upstream API written in a confident tone.
  for (const key of ["args", "sample", "expect"]) {
    if (action[key] === undefined) {
      fail(
        `${where}: "${key}" is required. Every generated action gets a test that replays a ` +
          `recorded upstream response ("sample") through the mapping and asserts the result ` +
          `("expect") for the given arguments ("args").`,
      );
    }
  }
  for (const name of Object.keys(action.args)) {
    if (!input[name]) fail(`${where}: args.${name} is not an input field.`);
  }
  for (const [name, field] of Object.entries(input)) {
    const required = !field.optional && field.default === undefined;
    if (required && action.args[name] === undefined) {
      fail(`${where}: input "${name}" is required, so args.${name} must be set.`);
    }
  }

  return {
    ...action,
    input,
    keywords: action.keywords ?? [],
    example: action.example ?? action.args,
  };
}
