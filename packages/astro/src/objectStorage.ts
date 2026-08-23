/**
 * Server-side object storage helpers for Astro endpoints / SSR.
 * ServerLoomupClient extends LoomupClient and already has `.storage`.
 */

import type {
  LoomupClient,
  StorageObject,
  StorageUploadOptions,
} from "@loomup/client";

export type UploadFormDataOptions = StorageUploadOptions & {
  fileField?: string;
  path?: string;
  pathField?: string;
  pathPrefix?: string;
};

function isFileLike(v: unknown): v is Blob & { name?: string; type: string } {
  return (
    typeof Blob !== "undefined" &&
    v instanceof Blob &&
    typeof (v as Blob).arrayBuffer === "function"
  );
}

export function fileAndPathFromFormData(
  form: FormData,
  options?: UploadFormDataOptions,
): { path: string; file: Blob; contentType?: string } {
  const fileField = options?.fileField ?? "file";
  const pathField = options?.pathField ?? "path";
  const raw = form.get(fileField);
  if (!isFileLike(raw)) {
    throw new Error(
      `@loomup/astro: FormData field "${fileField}" must be a File/Blob`,
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
      `@loomup/astro: object path required (pass options.path, form field "${pathField}", or a named File)`,
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

export async function storageDownloadResponse(
  client: LoomupClient,
  bucket: string,
  path: string,
  init?: ResponseInit,
): Promise<Response> {
  const upstream = await client.storage.from(bucket).downloadResponse(path);
  const headers = new Headers(init?.headers);
  for (const name of [
    "content-type",
    "content-length",
    "etag",
    "cache-control",
    "content-disposition",
  ] as const) {
    const v = upstream.headers.get(name);
    if (v && !headers.has(name)) headers.set(name, v);
  }
  return new Response(upstream.body, {
    status: init?.status ?? upstream.status,
    statusText: init?.statusText ?? upstream.statusText,
    headers,
  });
}
