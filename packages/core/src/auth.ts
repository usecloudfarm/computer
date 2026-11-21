import { z } from "zod";

/**
 * Auth schemes.
 *
 * An `AuthScheme` answers four questions in one object:
 *
 * 1. **What does the developer pass?** `input` — the schema for
 *    `slack({ apiKey: "xoxb-…" })`. Validated at construction, so a missing
 *    token is a clear error at wiring time rather than a 401 mid-task.
 * 2. **What is stored?** `credentials` — the shape a credential store (or, in
 *    v1, a closure) holds. It is deliberately separate from `input`: a user
 *    pastes a token, but an OAuth app stores an access token, a refresh token
 *    and an expiry, and those are not the same thing.
 * 3. **How do you get from one to the other?** `toCredentials`.
 * 4. **How is a request signed?** `authorize`, which receives the credentials
 *    and returns a new Request.
 *
 * The credentials are never put on `ActionContext`. A handler signs requests
 * by using `context.http` / `context.fetch`, which run `authorize` for it —
 * so the token is reachable only by the scheme, never a value a handler can
 * read, log, return, or leak into code mode. That property is the reason this
 * indirection exists at all; an app that simply closed over a string would be
 * shorter and strictly worse.
 */
export interface AuthScheme<Input = unknown, Credentials = unknown> {
  /** Identifies the scheme in errors and, later, in a credential store. */
  readonly kind: string;
  /** What the developer passes when constructing the app. */
  readonly input: z.ZodType<Input>;
  /** What is held on their behalf. */
  readonly credentials: z.ZodType<Credentials>;
  /** Input as given → credentials as stored. */
  toCredentials(input: Input): Credentials;
  /** Signs one request. Called per request, never memoised into a header map. */
  authorize(request: Request, credentials: Credentials): Request;
}

/** Keeps `AuthScheme`'s two type parameters inferable at the use site. */
export function defineAuth<Input, Credentials>(
  scheme: AuthScheme<Input, Credentials>,
): AuthScheme<Input, Credentials> {
  return scheme;
}

// --- api key ----------------------------------------------------------------

export interface ApiKeyOptions {
  /** Header to carry the key. Defaults to `authorization`. */
  readonly header?: string;
  /**
   * Prepended to the key, with a space. Defaults to `Bearer`; pass `""` for
   * APIs that want the raw key (Linear, for one).
   */
  readonly prefix?: string;
  /** Send it as a query parameter instead of a header. Rare, and weaker. */
  readonly query?: string;
  /** Shown to the developer when the key is missing. */
  readonly describe?: string;
}

export type ApiKeyCredentials = { readonly apiKey: string };

/**
 * A single long-lived secret: `slack({ apiKey: "xoxb-…" })`.
 *
 * A query-parameter key is supported because some APIs demand it, but it is
 * the weaker placement — query strings reach logs, proxies and referrers that
 * headers do not.
 */
export function apiKey(
  options: ApiKeyOptions = {},
): AuthScheme<ApiKeyCredentials, ApiKeyCredentials> {
  const header = options.header ?? "authorization";
  const prefix = options.prefix ?? "Bearer";
  const schema = z.object({
    apiKey: z
      .string()
      .min(1)
      .describe(options.describe ?? "API key or token for this service."),
  });

  return defineAuth({
    kind: "apiKey",
    input: schema,
    credentials: schema,
    toCredentials: (input) => input,
    authorize: (request, credentials) => {
      if (options.query) {
        const url = new URL(request.url);
        url.searchParams.set(options.query, credentials.apiKey);
        return new Request(url, request);
      }
      const authorized = new Request(request);
      authorized.headers.set(
        header,
        prefix ? `${prefix} ${credentials.apiKey}` : credentials.apiKey,
      );
      return authorized;
    },
  });
}

// --- basic ------------------------------------------------------------------

export type BasicCredentials = { readonly username: string; readonly password: string };

/** HTTP Basic. The pair is encoded per request rather than stored pre-encoded. */
export function basic(): AuthScheme<BasicCredentials, BasicCredentials> {
  const schema = z.object({
    username: z.string().min(1),
    password: z.string().min(1).describe("Password or personal access token."),
  });

  return defineAuth({
    kind: "basic",
    input: schema,
    credentials: schema,
    toCredentials: (input) => input,
    authorize: (request, credentials) => {
      const authorized = new Request(request);
      authorized.headers.set(
        "authorization",
        `Basic ${encodeBase64(`${credentials.username}:${credentials.password}`)}`,
      );
      return authorized;
    },
  });
}

/** `btoa` is in both runtimes, but is latin1-only; encode UTF-8 ourselves. */
function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// --- oauth ------------------------------------------------------------------

export interface OAuthOptions {
  /** Scopes this app needs. Metadata today; the consent URL builder when the flow lands. */
  readonly scopes?: readonly string[];
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly describe?: string;
}

const OAUTH = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds. Absent means unknown, not "never expires". */
  expiresAt: z.number().int().positive().optional(),
});
export type OAuthCredentials = z.infer<typeof OAUTH>;

/**
 * OAuth 2 credentials.
 *
 * **The flow is not implemented.** There is no consent redirect and no token
 * refresh in v1 — this defines the credential shape, validates it, and signs
 * requests with the access token. It exists now so that the shape is right
 * before anything stores it: adding `refreshToken` or an account id to a
 * stored credential later is a migration, and designing it in costs nothing
 * today. `expiresAt` is checked on use, so an expired token fails with a clear
 * message instead of an opaque 401.
 */
export function oauth(options: OAuthOptions = {}): AuthScheme<OAuthCredentials, OAuthCredentials> {
  const schema = OAUTH.extend({
    accessToken: z
      .string()
      .min(1)
      .describe(options.describe ?? "OAuth 2 access token."),
  });

  return defineAuth({
    kind: "oauth2",
    input: schema,
    credentials: schema,
    toCredentials: (input) => input,
    authorize: (request, credentials) => {
      if (credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now()) {
        throw new Error(
          "The OAuth access token expired. Refresh it and rebuild the app; automatic refresh is not implemented yet.",
        );
      }
      const authorized = new Request(request);
      authorized.headers.set("authorization", `Bearer ${credentials.accessToken}`);
      return authorized;
    },
  });
}

// --- none -------------------------------------------------------------------

/** For public APIs. Explicit, so "no auth" is a decision rather than an omission. */
export function noAuth(): AuthScheme<Record<string, never>, Record<string, never>> {
  const schema = z.object({});
  return defineAuth({
    kind: "none",
    input: schema,
    credentials: schema,
    toCredentials: () => ({}),
    authorize: (request) => request,
  });
}
