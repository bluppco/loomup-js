import { useCallback, useEffect, useState } from "react";
import { LoomupError, type AuthTokens, type OAuthProvider, type User } from "@loomup/client";
import { useLoomupContext } from "./context.js";
import { clearTokens, loadTokens, saveTokens } from "./storage.js";
import { errorMessage } from "./utils.js";

export type AuthSession = {
  accessToken: string | undefined;
  refreshToken: string | undefined;
};

export type UseAuthResult = {
  user: User | null;
  session: AuthSession;
  loading: boolean;
  error: string | null;
  signIn: (creds: { email: string; password: string }) => Promise<AuthTokens>;
  signUp: (creds: { email: string; password: string }) => Promise<AuthTokens>;
  signInWithOAuth: (provider: OAuthProvider, redirectTo: string) => Promise<void>;
  completeOAuthSignIn: (callbackUrl?: string) => Promise<AuthTokens>;
  signOut: () => Promise<void>;
  refresh: () => Promise<AuthTokens>;
  me: () => Promise<User>;
};

/**
 * Auth session hook. Hydrates from client tokens (and optional token storage),
 * exposes signIn/signUp/signOut/me/refresh with React state.
 */
export function useAuth(): UseAuthResult {
  const { client, persist } = useLoomupContext();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<AuthSession>({
    accessToken: client.accessToken,
    refreshToken: undefined,
  });

  const applyTokens = useCallback(
    async (data: AuthTokens) => {
      setUser(data.user ?? null);
      setSession({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      });
      if (persist.enabled) {
        await saveTokens(
          persist.storage,
          persist.storageKey,
          data.access_token,
          data.refresh_token,
        );
      }
    },
    [persist.enabled, persist.storage, persist.storageKey],
  );

  // Hydrate tokens + current user on mount.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        if (persist.enabled) {
          const stored = await loadTokens(persist.storage, persist.storageKey);
          if (stored.access) client.setToken(stored.access);
          if (stored.refresh) client.setRefreshToken(stored.refresh);
        }

        if (!client.accessToken) {
          if (!cancelled) {
            setUser(null);
            setSession({ accessToken: undefined, refreshToken: undefined });
          }
          return;
        }

        const me = await client.auth.me();
        if (!cancelled) {
          setUser(me);
          setSession((s) => ({
            accessToken: client.accessToken,
            refreshToken: s.refreshToken,
          }));
        }
      } catch (err) {
        if (!cancelled) {
          setUser(null);
          setError(errorMessage(err));
          if (persist.enabled) {
            await clearTokens(persist.storage, persist.storageKey);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-run only when client or persist config changes.
  }, [client, persist.enabled, persist.storage, persist.storageKey]);

  const signIn = useCallback(
    async (creds: { email: string; password: string }) => {
      setError(null);
      setLoading(true);
      try {
        const tokens = await client.auth.signIn(creds);
        await applyTokens(tokens);
        if (!tokens.user) {
          try {
            const me = await client.auth.me();
            setUser(me);
          } catch {
            /* user optional */
          }
        }
        return tokens;
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client, applyTokens],
  );

  const signUp = useCallback(
    async (creds: { email: string; password: string }) => {
      setError(null);
      setLoading(true);
      try {
        const tokens = await client.auth.signUp(creds);
        await applyTokens(tokens);
        if (!tokens.user) {
          try {
            const me = await client.auth.me();
            setUser(me);
          } catch {
            /* user optional */
          }
        }
        return tokens;
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client, applyTokens],
  );

  const signOut = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      await client.auth.signOut();
      setUser(null);
      setSession({ accessToken: undefined, refreshToken: undefined });
      if (persist.enabled) {
        await clearTokens(persist.storage, persist.storageKey);
      }
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, [client, persist.enabled, persist.storage, persist.storageKey]);

  const signInWithOAuth = useCallback(
    async (provider: OAuthProvider, redirectTo: string) => {
      setError(null);
      const authorization = await client.auth.authorizeOAuth({ provider, redirectTo });
      if (typeof globalThis.sessionStorage === "undefined") {
        throw new Error("OAuth sign-in requires browser sessionStorage");
      }
      globalThis.sessionStorage.setItem("loomup:oauth:code-verifier", authorization.code_verifier);
      globalThis.location.assign(authorization.authorization_url);
    },
    [client],
  );

  const completeOAuthSignIn = useCallback(
    async (callbackUrl = globalThis.location?.href) => {
      setError(null);
      setLoading(true);
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
        await applyTokens(tokens);
        return tokens;
      } catch (err) {
        setError(errorMessage(err));
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [client, applyTokens],
  );

  const refresh = useCallback(async () => {
    setError(null);
    const tokens = await client.auth.refresh();
    await applyTokens(tokens);
    return tokens;
  }, [client, applyTokens]);

  const me = useCallback(async () => {
    setError(null);
    const u = await client.auth.me();
    setUser(u);
    return u;
  }, [client]);

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
