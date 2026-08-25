import { onMounted, onUnmounted, ref, type Ref } from "vue";
import { LoomupError, type AuthSignUpResult, type AuthTokens, type OAuthProvider, type User } from "@loomup/client";
import { useLoomupContext } from "./inject.js";
import { errorMessage } from "./utils.js";

export type AuthSession = {
  accessToken: string | undefined;
  refreshToken: string | undefined;
};

export type UseAuthResult = {
  user: Ref<User | null>;
  session: Ref<AuthSession>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  signIn: (creds: { email: string; password: string }) => Promise<AuthTokens>;
  signUp: (creds: { email: string; password: string }) => Promise<AuthSignUpResult>;
  signInWithOAuth: (provider: OAuthProvider, redirectTo: string) => Promise<void>;
  completeOAuthSignIn: (callbackUrl?: string) => Promise<AuthTokens>;
  signOut: () => Promise<void>;
  refresh: () => Promise<AuthTokens>;
  me: () => Promise<User>;
};

function storageAvailable(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function loadTokens(storageKey: string): {
  access?: string;
  refresh?: string;
} {
  if (!storageAvailable()) return {};
  try {
    const access = localStorage.getItem(`${storageKey}:access`) ?? undefined;
    const refresh = localStorage.getItem(`${storageKey}:refresh`) ?? undefined;
    return {
      access: access || undefined,
      refresh: refresh || undefined,
    };
  } catch {
    return {};
  }
}

function saveTokens(
  storageKey: string,
  access?: string,
  refresh?: string,
): void {
  if (!storageAvailable()) return;
  try {
    if (access) localStorage.setItem(`${storageKey}:access`, access);
    else localStorage.removeItem(`${storageKey}:access`);
    if (refresh) localStorage.setItem(`${storageKey}:refresh`, refresh);
    else localStorage.removeItem(`${storageKey}:refresh`);
  } catch {
    /* ignore quota / private mode */
  }
}

function clearTokens(storageKey: string): void {
  saveTokens(storageKey, undefined, undefined);
}

/**
 * Auth session composable. Hydrates from client tokens (and optional localStorage),
 * exposes signIn/signUp/signOut/me/refresh with reactive state.
 */
export function useAuth(): UseAuthResult {
  const { client, persist } = useLoomupContext();
  const user = ref<User | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  const session = ref<AuthSession>({
    accessToken: client.accessToken,
    refreshToken: undefined,
  });

  function applyTokens(data: AuthTokens) {
    user.value = data.user ?? null;
    session.value = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
    if (persist.enabled) {
      saveTokens(persist.storageKey, data.access_token, data.refresh_token);
    }
  }

  let cancelled = false;

  onMounted(() => {
    cancelled = false;
    void (async () => {
      loading.value = true;
      error.value = null;
      try {
        if (persist.enabled) {
          const stored = loadTokens(persist.storageKey);
          if (stored.access) client.setToken(stored.access);
          if (stored.refresh) client.setRefreshToken(stored.refresh);
        }

        if (!client.accessToken) {
          if (!cancelled) {
            user.value = null;
            session.value = { accessToken: undefined, refreshToken: undefined };
          }
          return;
        }

        const meUser = await client.auth.me();
        if (!cancelled) {
          user.value = meUser;
          session.value = {
            accessToken: client.accessToken,
            refreshToken: session.value.refreshToken,
          };
        }
      } catch (err) {
        if (!cancelled) {
          user.value = null;
          error.value = errorMessage(err);
          if (persist.enabled) clearTokens(persist.storageKey);
        }
      } finally {
        if (!cancelled) loading.value = false;
      }
    })();
  });

  onUnmounted(() => {
    cancelled = true;
  });

  async function signIn(creds: { email: string; password: string }) {
    error.value = null;
    loading.value = true;
    try {
      const tokens = await client.auth.signIn(creds);
      applyTokens(tokens);
      if (!tokens.user) {
        try {
          const meUser = await client.auth.me();
          user.value = meUser;
        } catch {
          /* user optional */
        }
      }
      return tokens;
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function signUp(creds: { email: string; password: string }) {
    error.value = null;
    loading.value = true;
    try {
      const result = await client.auth.signUp(creds);
      if (!("access_token" in result)) {
        client.setToken(undefined);
        client.setRefreshToken(undefined);
        user.value = null;
        session.value = { accessToken: undefined, refreshToken: undefined };
        if (persist.enabled) clearTokens(persist.storageKey);
        return result;
      }
      applyTokens(result);
      if (!result.user) {
        try {
          const meUser = await client.auth.me();
          user.value = meUser;
        } catch {
          /* user optional */
        }
      }
      return result;
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function signOut() {
    error.value = null;
    loading.value = true;
    try {
      await client.auth.signOut();
      user.value = null;
      session.value = { accessToken: undefined, refreshToken: undefined };
      if (persist.enabled) clearTokens(persist.storageKey);
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function signInWithOAuth(provider: OAuthProvider, redirectTo: string) {
    error.value = null;
    const authorization = await client.auth.authorizeOAuth({ provider, redirectTo });
    if (typeof globalThis.sessionStorage === "undefined") {
      throw new Error("OAuth sign-in requires browser sessionStorage");
    }
    globalThis.sessionStorage.setItem("loomup:oauth:code-verifier", authorization.code_verifier);
    globalThis.location.assign(authorization.authorization_url);
  }

  async function completeOAuthSignIn(callbackUrl = globalThis.location?.href) {
    error.value = null;
    loading.value = true;
    try {
      if (!callbackUrl || typeof globalThis.sessionStorage === "undefined") {
        throw new LoomupError("OAuth callback URL or verifier is unavailable", "oauth_callback_incomplete");
      }
      const callback = new URL(callbackUrl);
      const providerError = callback.searchParams.get("error");
      if (providerError) {
        globalThis.sessionStorage.removeItem("loomup:oauth:code-verifier");
        throw new LoomupError(`OAuth sign-in failed: ${providerError}`, providerError);
      }
      const code = callback.searchParams.get("code");
      const codeVerifier = globalThis.sessionStorage.getItem("loomup:oauth:code-verifier");
      if (!code || !codeVerifier) {
        throw new LoomupError("OAuth callback is incomplete", "oauth_callback_incomplete");
      }
      const tokens = await client.auth.exchangeOAuthCode({ code, codeVerifier });
      globalThis.sessionStorage.removeItem("loomup:oauth:code-verifier");
      applyTokens(tokens);
      return tokens;
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    error.value = null;
    const tokens = await client.auth.refresh();
    applyTokens(tokens);
    return tokens;
  }

  async function me() {
    error.value = null;
    const u = await client.auth.me();
    user.value = u;
    return u;
  }

  return {
    user,
    session,
    loading,
    error,
    signIn,
    signUp,
    signInWithOAuth,
    completeOAuthSignIn,
    signOut,
    refresh,
    me,
  };
}
