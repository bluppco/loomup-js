/** Server-only normalization of Loomup JSON and HttpOnly cookie credentials. */
import { LoomupError } from "@loomup/client";

type SetCookieHeaders = Headers & {
  getSetCookie?: () => string[];
  getAll?: (name: string) => string[];
};

function credential(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function upstreamCookie(headers: Headers, name: string): string | undefined {
  const extended = headers as SetCookieHeaders;
  const values =
    typeof extended.getSetCookie === "function"
      ? extended.getSetCookie()
      : typeof extended.getAll === "function"
        ? extended.getAll("Set-Cookie")
        : [headers.get("Set-Cookie") ?? ""];
  // Match cookie boundaries, without splitting commas inside Expires dates.
  const pattern = new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`);
  for (const value of values) {
    const match = pattern.exec(value);
    const token = credential(match?.[1]?.replace(/^"|"$/g, ""));
    if (token) return token;
  }
  return undefined;
}

export function assertSessionTokens(tokens: {
  access_token?: unknown;
  refresh_token?: unknown;
}): asserts tokens is { access_token: string; refresh_token: string } {
  if (!credential(tokens.access_token) || !credential(tokens.refresh_token)) {
    throw new LoomupError(
      "Loomup auth response did not include a complete session",
      "invalid_response",
      502,
    );
  }
}

export function normalizeAuthTokens(data: unknown, headers: Headers) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LoomupError("invalid response from Loomup", "invalid_response", 502);
  }
  const payload = data as Record<string, unknown>;
  const tokens = {
    ...payload,
    access_token: credential(payload.access_token) ?? upstreamCookie(headers, "loomup_access"),
    refresh_token: credential(payload.refresh_token) ?? upstreamCookie(headers, "loomup_refresh"),
  };
  assertSessionTokens(tokens);
  return tokens;
}
