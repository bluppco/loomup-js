/**
 * Server-side object storage helpers for Next.js (Route Handlers, Server Actions).
 *
 * Cookie-session clients from createServerClient / createPagesServerClient already
 * expose `client.storage` from `@loomup/client`. These helpers convert FormData
 * and build download Responses for App Router.
 */

import type {
  LoomupClient,
  StorageObject,
  StorageUploadOptions,
} from "@loomup/client";

export type UploadFormDataOptions = StorageUploadOptions & {
  /** Form field name for the file (default `file`). */
  fileField?: string;
  /**
   * Object path inside the bucket. If omitted, uses form field `path` or the
   * uploaded file's `name`.
   */
  path?: string;
  /** Form field that supplies the object path when `path` is not set (default `path`). */
  pathField?: string;
  /**
   * Optional path prefix (e.g. `userId/`). Joined with the resolved path;
   * trailing slash is added if missing.
   */
  pathPrefix?: string;
};

function isFileLike(v: unknown): v is Blob & { name?: string; type: string } {
  return (
    typeof Blob !== "undefined" &&
    v instanceof Blob &&
    typeof (v as Blob).arrayBuffer === "function"
  );
}

/**
 * Resolve object path + File/Blob from a multipart FormData body.
 */
export function fileAndPathFromFormData(
  form: FormData,
  options?: UploadFormDataOptions,
): { path: string; file: Blob; contentType?: string } {
  const fileField = options?.fileField ?? "file";
  const pathField = options?.pathField ?? "path";
  const raw = form.get(fileField);
  if (!isFileLike(raw)) {
    throw new Error(
      `@loomup/next: FormData field "${fileField}" must be a File/Blob`,
    );
  }
  let path =
    options?.path ??
    (typeof form.get(pathField) === "string"
      ? String(form.get(pathField))
      : undefined) ??
    (typeof raw.name === "string" && raw.name ? raw.name : undefined);
  if (!path || !path.trim()) {
    throw new Error(
      `@loomup/next: object path required (pass options.path, form field "${pathField}", or a named File)`,
    );
  }
  path = path.replace(/^\/+/, "");
  if (options?.pathPrefix) {
    const prefix = options.pathPrefix.endsWith("/")
      ? options.pathPrefix
      : `${options.pathPrefix}/`;
    path = `${prefix}${path}`;
  }
  const contentType =
    options?.contentType ??
    (raw.type && raw.type.length > 0 ? raw.type : undefined);
  return { path, file: raw, contentType };
}

/**
 * Upload a file from FormData using an authenticated server client.
 *
 * @example Route Handler
 * ```ts
 * const client = await createServerClient({ url, cookies });
 * const meta = await uploadFromFormData(client, "avatars", await request.formData(), {
 *   pathPrefix: `${userId}/`,
 *   upsert: true,
 * });
 * return Response.json({ data: meta });
 * ```
 */
export async function uploadFromFormData(
  client: LoomupClient,
  bucket: string,
  form: FormData,
  options?: UploadFormDataOptions,
): Promise<StorageObject> {
  const { path, file, contentType } = fileAndPathFromFormData(form, options);
  return client.storage.from(bucket).upload(path, file, {
    contentType,
    upsert: options?.upsert,
  });
}

/**
 * Build a Web Response that streams (or buffers) a stored object for download.
 * Forwards Content-Type, ETag, Content-Length, and Cache-Control when present.
 */
export async function storageDownloadResponse(
  client: LoomupClient,
  bucket: string,
  path: string,
  init?: ResponseInit,
): Promise<Response> {
  const upstream = await client.storage.from(bucket).downloadResponse(path);
  const headers = new Headers(init?.headers);
  const pass = [
    "content-type",
    "content-length",
    "etag",
    "cache-control",
    "content-disposition",
  ] as const;
  for (const name of pass) {
    const v = upstream.headers.get(name);
    if (v && !headers.has(name)) headers.set(name, v);
  }
  return new Response(upstream.body, {
    status: init?.status ?? upstream.status,
    statusText: init?.statusText ?? upstream.statusText,
    headers,
  });
}
