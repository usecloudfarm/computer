import { AwsClient } from "aws4fetch";
import type { FileStat, FileSystem, StorageProvider } from "@cloudfarm/computer";

export interface S3StorageOptions {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Full endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. Defaults to AWS. */
  readonly endpoint?: string;
  readonly region?: string;
  /** MinIO and some gateways need `bucket/key` in the path rather than in the host. */
  readonly pathStyle?: boolean;
  /**
   * Where the users' folders start inside the bucket. Defaults to `cloudfarm/`;
   * pass `""` when the bucket is already dedicated to this.
   *
   * The layout under it is `<userId>/workspaces/<workspaceId>/`. The user owns
   * the root folder, so anything of theirs that outlives a single workspace
   * has somewhere to sit beside `workspaces/`, and a credential scoped to one
   * user cannot reach another's.
   */
  readonly prefix?: string;
}

/**
 * Any S3-compatible bucket as workspace storage: AWS, R2, MinIO, B2.
 *
 * The point is whose bucket it is. Files stay in storage the user owns and
 * can audit, rather than in a database we run — which also keeps us out of
 * their residency and retention story.
 *
 * Signing is `aws4fetch`: SigV4 over WebCrypto, so this works unchanged on
 * Workers and Node. An AWS SDK would not.
 */
export class S3Storage implements StorageProvider {
  readonly id = "s3";
  readonly description =
    "Workspace files in an S3-compatible bucket you own. Durable, unbounded, and mountable " +
    "by sandboxes that support it.";

  readonly #options: S3StorageOptions;
  readonly #client: AwsClient;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new Error("s3 storage needs a bucket");
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new Error("s3 storage needs accessKeyId and secretAccessKey");
    }
    this.#options = options;
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
      service: "s3",
      region: options.region ?? "auto",
    });
  }

  async open(scope: { userId: string; workspaceId: string }): Promise<FileSystem> {
    return new S3FileSystem(this.#client, this.#options, prefixFor(this.#options, scope));
  }
}

/** Convenience for the common case: `storage: s3({ bucket, accessKeyId, … })`. */
export function s3(options: S3StorageOptions): S3Storage {
  return new S3Storage(options);
}

class S3FileSystem implements FileSystem {
  constructor(
    readonly client: AwsClient,
    readonly options: S3StorageOptions,
    readonly prefix: string,
  ) {}

  async read(path: string): Promise<Uint8Array> {
    const response = await this.#send("GET", this.#key(path));
    if (response.status === 404) throw new Error(`No such file: ${path}`);
    await assertOk(response, "read", path);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  async write(path: string, data: Uint8Array | string): Promise<FileStat> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const response = await this.#send("PUT", this.#key(path), {
      body: body as unknown as BodyInit,
      headers: { "content-length": String(body.byteLength) },
    });
    await assertOk(response, "write", path);
    return { path: normalize(path), size: body.byteLength, mtime: Date.now(), type: "file" };
  }

  async stat(path: string): Promise<FileStat | null> {
    const response = await this.#send("HEAD", this.#key(path));
    if (response.status === 404) return null;
    await assertOk(response, "stat", path);
    return {
      path: normalize(path),
      size: Number(response.headers.get("content-length") ?? 0),
      mtime: Date.parse(response.headers.get("last-modified") ?? "") || Date.now(),
      type: "file",
    };
  }

  async *list(prefix = "/"): AsyncIterable<FileStat> {
    const scoped = this.#key(prefix).replace(/\/+$/, "");
    const seen = new Set<string>();
    let token: string | undefined;

    do {
      const url = new URL(this.#url(""));
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", scoped ? `${scoped}/` : "");
      if (token) url.searchParams.set("continuation-token", token);

      const response = await this.client.fetch(url.toString(), { method: "GET" });
      await assertOk(response, "list", prefix);
      const xml = await response.text();

      // Directories do not exist in S3; they are implied by key separators,
      // so they are synthesised here to match the FileSystem contract.
      for (const { key, size, mtime } of parseListing(xml)) {
        const path = `/${key.slice(this.prefix.length).replace(/^\/+/, "")}`;
        for (const directory of parents(path)) {
          if (seen.has(directory)) continue;
          seen.add(directory);
          yield { path: directory, size: 0, mtime, type: "directory" };
        }
        yield { path, size, mtime, type: "file" };
      }
      token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1];
    } while (token);
  }

  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (options.recursive) {
      // No recursive delete in S3: every key under the prefix is its own call.
      for await (const entry of this.list(path)) {
        if (entry.type === "file") await this.#send("DELETE", this.#key(entry.path));
      }
    }
    const response = await this.#send("DELETE", this.#key(path));
    await assertOk(response, "remove", path);
  }

  async move(from: string, to: string): Promise<void> {
    // S3 has no rename: copy then delete, which is not atomic. A crash
    // between the two leaves both keys, which is better than leaving neither.
    const source = `/${this.options.bucket}/${this.#key(from)}`;
    const response = await this.#send("PUT", this.#key(to), {
      headers: { "x-amz-copy-source": encodeURI(source) },
    });
    await assertOk(response, "move", from);
    await this.remove(from);
  }

  #key(path: string): string {
    return `${this.prefix}${normalize(path).slice(1)}`;
  }

  #url(key: string): string {
    const endpoint = (this.options.endpoint ?? "https://s3.amazonaws.com").replace(/\/+$/, "");
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    if (this.options.pathStyle) return `${endpoint}/${this.options.bucket}/${encoded}`;
    const url = new URL(endpoint);
    return `${url.protocol}//${this.options.bucket}.${url.host}/${encoded}`;
  }

  #send(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    return this.client.fetch(this.#url(key), { method, ...init });
  }
}

/**
 * The subtree one workspace reads and writes:
 * `<prefix>/<userId>/workspaces/<workspaceId>/`.
 *
 * `workspaces/` is a literal segment rather than the workspace id sitting
 * directly under the user, so the user's folder stays open for everything
 * that is theirs rather than one session's — and a key can be told apart by
 * reading it.
 */
function prefixFor(
  options: S3StorageOptions,
  scope: { userId: string; workspaceId: string },
): string {
  const root = (options.prefix ?? "cloudfarm").replace(/^\/+|\/+$/g, "");
  const user = encodeURIComponent(scope.userId);
  const workspace = encodeURIComponent(scope.workspaceId);
  return `${root ? `${root}/` : ""}${user}/workspaces/${workspace}/`;
}

function normalize(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/** `/a/b/c.txt` → `/a`, `/a/b`. */
function parents(path: string): string[] {
  const parts = path.split("/").filter(Boolean).slice(0, -1);
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
}

interface Listed {
  key: string;
  size: number;
  mtime: number;
}

/**
 * ListObjectsV2 answers XML, and there is no XML parser on Workers.
 *
 * The shape is fixed and shallow, so a regex over `<Contents>` blocks is
 * enough — and far smaller than shipping a parser to satisfy one endpoint.
 */
function parseListing(xml: string): Listed[] {
  const results: Listed[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1];
    if (!block) continue;
    const key = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
    if (!key || key.endsWith("/")) continue;
    results.push({
      key: decodeEntities(key),
      size: Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? 0),
      mtime: Date.parse(/<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1] ?? "") || 0,
    });
  }
  return results;
}

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

function decodeEntities(value: string): string {
  let text = value;
  for (const [entity, character] of Object.entries(ENTITIES)) {
    text = text.replaceAll(entity, character);
  }
  // `&amp;` last, or it would re-introduce entities it just decoded.
  return text.replaceAll("&amp;", "&");
}

async function assertOk(response: Response, operation: string, path: string): Promise<void> {
  if (response.ok) return;
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    // A body is a nicety here, not a requirement.
  }
  throw new Error(`s3 ${operation} failed for ${path}: HTTP ${response.status} ${detail}`);
}
