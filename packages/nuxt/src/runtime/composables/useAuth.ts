/**
 * Auth composable — uses Nuxt-origin auth routes so HttpOnly cookies are set.
 */

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { AuthSignUpResult, AuthTokens, AuthVerificationPending, User } from "@loomup/client";
import { useLoomupState, type LoomupPluginState } from "./useLoomup.js";
import { errorMessage } from "./utils.js";

export type UseAuthResult = {
  user: ComputedRef<User | null>;
  accessToken: ComputedRef<string | undefined>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  signIn: (creds: { email: string; password: string }) => Promise<AuthTokens>;
  signUp: (creds: { email: string; password: string }) => Promise<AuthSignUpResult>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  me: () => Promise<User | null>;
};

declare function useRuntimeConfig(): {
  public: { loomupAuthBasePath?: string; loomupUrl?: string };
};

function authBasePath(): string {
  try {
    const config = useRuntimeConfig();
    return config.public?.loomupAuthBasePath || "/api/auth";
  } catch {
    return "/api/auth";
  }
}

async function postAuth(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }
  return { ok: res.ok, status: res.status, json };
}

function tokensFromData(data: unknown): AuthTokens | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const access = d.access_token;
  if (typeof access !== "string") return null;
  return {
    access_token: access,
    refresh_token: "", // refresh stays HttpOnly; not returned to client
    token_type: typeof d.token_type === "string" ? d.token_type : "Bearer",
    expires_in: typeof d.expires_in === "number" ? d.expires_in : 0,
    user: d.user as User | undefined,
  };
}

function verificationPendingFromData(data: unknown): AuthVerificationPending | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (value.verification_required !== true || typeof value.expires_in !== "number") {
    return null;
  }
  if (!value.user || typeof value.user !== "object") return null;
  return value as AuthVerificationPending;
}

export function useAuth(): UseAuthResult {
  const state: LoomupPluginState = useLoomupState();
  const loading = ref(false);
  const error = ref<string | null>(null);
  const base = authBasePath();

  const user = computed(() => state.user);
  const accessToken = computed(() => state.accessToken);

  async function signIn(creds: {
    email: string;
    password: string;
  }): Promise<AuthTokens> {
    loading.value = true;
    error.value = null;
    try {
      const { ok, json } = await postAuth(`${base}/login`, creds);
      if (!ok) {
        const err = json.error as { message?: string } | undefined;
        throw new Error(err?.message || "login failed");
      }
      const data = json.data;
      const tokens = tokensFromData(data);
      if (tokens) {
        state.setSession(tokens);
        return tokens;
      }
      // Even without access_token in body, cookies were set — hydrate session.
      await state.refreshSession();
      return {
        access_token: state.accessToken || "",
        refresh_token: "",
        token_type: "Bearer",
        expires_in: 0,
        user: state.user ?? undefined,
      };
    } catch (e) {
      error.value = errorMessage(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function signUp(creds: {
    email: string;
    password: string;
  }): Promise<AuthSignUpResult> {
    loading.value = true;
    error.value = null;
    try {
      const { ok, json } = await postAuth(`${base}/register`, creds);
      if (!ok) {
        const err = json.error as { message?: string } | undefined;
        throw new Error(err?.message || "register failed");
      }
      const tokens = tokensFromData(json.data);
      if (tokens) {
        state.setSession(tokens);
        return tokens;
      }
      const pending = verificationPendingFromData(json.data);
      if (pending) {
        state.setSession(null);
        return pending;
      }
      await state.refreshSession();
      return {
        access_token: state.accessToken || "",
        refresh_token: "",
        token_type: "Bearer",
        expires_in: 0,
        user: state.user ?? undefined,
      };
    } catch (e) {
      error.value = errorMessage(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function signOut(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await postAuth(`${base}/logout`);
      state.setSession(null);
    } catch (e) {
      error.value = errorMessage(e);
      state.setSession(null);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const { ok, json } = await postAuth(`${base}/refresh`);
      if (!ok) {
        state.setSession(null);
        const err = json.error as { message?: string } | undefined;
        throw new Error(err?.message || "refresh failed");
      }
      const tokens = tokensFromData(json.data);
      if (tokens) state.setSession(tokens);
      else await state.refreshSession();
    } catch (e) {
      error.value = errorMessage(e);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function me(): Promise<User | null> {
    await state.refreshSession();
    return state.user;
  }

  return {
    user,
    accessToken,
    loading,
    error,
    signIn,
    signUp,
    signOut,
    refresh,
    me,
  };
}
