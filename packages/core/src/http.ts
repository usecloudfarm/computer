import { CloudfarmError, HttpError } from "./errors.js";

/**
 * A JSON client over the app's authorized fetch.
 *
 * `context.fetch` is already fetch, and it stays — this is not a replacement
 * for it. What it removes is the identical twenty lines every app was writing
 * around it: build a URL with query parameters, set the JSON headers, stringify,
 * check `response.ok`, parse, and throw on failure.
 *
 * The last of those is why this lives in core rather than in each app. A
 * hand-rolled `throw new Error("… HTTP 429 …")` is an anonymous Error, and
 * `classifyError` can only call an anonymous Error `internal` with
 * `retryable: false`. So a rate limit — the most retryable failure there is —
 * reached the model as a permanent internal fault, and no amount of care in
 * the app could fix it, because the type carried no status. `HttpError` does,
 * and `classifyError` maps it onto the vocabulary the model already knows.
 */

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpOptions {
  /** Appended to the URL. `undefined` and `null` entries are dropped, not stringified. */
  readonly query?: Record<string, QueryValue>;
  readonly headers?: Record<string, string>;
  /** Sent as JSON. Use `form` for `application/x-www-form-urlencoded` APIs. */
  readonly body?: unknown;
  readonly form?: Record<string, QueryValue>;
}

export interface HttpClient {
  get<T = Record<string, unknown>>(path: string, options?: HttpOptions): Promise<T>;
  post<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: Omit<HttpOptions, "body">,
  ): Promise<T>;
  put<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: Omit<HttpOptions, "body">,
  ): Promise<T>;
  patch<T = Record<string, unknown>>(
    path: string,
    body?: unknown,
    options?: Omit<HttpOptions, "body">,
  ): Promise<T>;
  delete<T = Record<string, unknown>>(path: string, options?: HttpOptions): Promise<T>;
  request<T = Record<string, unknown>>(
    method: string,
    path: string,
    options?: HttpOptions,
  ): Promise<T>;
}

export interface HttpConfig {
  /** Prefix for relative paths. An absolute URL passed to a method wins over it. */
  readonly baseUrl?: string;
  /** Sent on every request. The credential does not belong here — use `authorize`. */
  readonly headers?: Record<string, string>;
  /**
   * Inspect a successful response's body. Throw `UpstreamRejectedError` when a
   * 200 actually means failure, as it does for APIs that answer
   * `{ ok: false, error }` with HTTP 200.
   */
  readonly validate?: (body: unknown, response: Response) => void;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createHttpClient(fetcher: Fetcher, config: HttpConfig = {}): HttpClient {
  const request = async <T>(
    method: string,
    path: string,
    options: HttpOptions = {},
  ): Promise<T> => {
    const url = resolveUrl(path, config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      ...config.headers,
      ...options.headers,
    };

    let body: string | undefined;
    if (options.form !== undefined) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(options.form)) {
        if (value !== undefined && value !== null) form.set(key, String(value));
      }
      body = form.toString();
      headers["content-type"] = "application/x-www-form-urlencoded; charset=utf-8";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json; charset=utf-8";
    }

    const response = await fetcher(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    const parsed = await readBody(response);
    if (!response.ok) {
      throw new HttpError(
        response.status,
        url.toString(),
        parsed,
        `HTTP ${response.status} ${response.statusText} from ${url.pathname}${describe(parsed)}`,
      );
    }
    config.validate?.(parsed, response);
    return parsed as T;
  };

  return {
    request,
    get: (path, options) => request("GET", path, options ?? {}),
    post: (path, body, options) => request("POST", path, { ...options, ...bodyOf(body) }),
    put: (path, body, options) => request("PUT", path, { ...options, ...bodyOf(body) }),
    patch: (path, body, options) => request("PATCH", path, { ...options, ...bodyOf(body) }),
    delete: (path, options) => request("DELETE", path, options ?? {}),
  };
}

/** `undefined` must stay absent: `{ body: undefined }` would still send a body header. */
function bodyOf(body: unknown): { body?: unknown } {
  return body === undefined ? {} : { body };
}

function resolveUrl(path: string, baseUrl?: string): URL {
  if (/^https?:\/\//i.test(path)) return new URL(path);
  if (!baseUrl) {
    throw new CloudfarmError(
      `"${path}" is relative but the app set no http.baseUrl. Pass an absolute URL or configure one.`,
    );
  }
  // A trailing slash on the base is what silently eats a path segment in
  // `new URL()`, so join explicitly rather than relying on its resolution.
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}

/**
 * Parse as JSON when it parses, whatever the header says.
 *
 * Trusting `content-type` looks tidier and is wrong in practice: plenty of
 * services answer JSON as `text/plain`, and a test double built with
 * `new Response(JSON.stringify(…))` sends `text/plain` unless you remember
 * otherwise. Sniffing the header there turns a structured error body into an
 * opaque string, and the app reads `undefined` for every field.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A short tail of the error body, so a failure says something useful. */
function describe(body: unknown): string {
  if (body === null || body === undefined) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (!text) return "";
  return `: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}
