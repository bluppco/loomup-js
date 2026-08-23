"use client";

/**
 * Optional React provider for Client Components.
 * Hydrate with accessToken from the server (session route or RSC prop).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import {
  createClient,
  type LoomupClient,
  type User,
  type AuthTokens,
} from "@loomup/client";

export type LoomupContextValue = {
  client: LoomupClient;
  user: User | null;
  accessToken: string | undefined;
  setSession: (tokens: AuthTokens | null) => void;
};

const LoomupContext = createContext<LoomupContextValue | null>(null);

export type LoomupProviderProps = {
  url: string;
  children: ReactNode;
  /** Hydrate from server session (HttpOnly cookies stay on the server). */
  accessToken?: string;
  user?: User | null;
};

export function LoomupProvider({
  url,
  children,
  accessToken: initialAccess,
  user: initialUser = null,
}: LoomupProviderProps) {
  const [accessToken, setAccessToken] = useState<string | undefined>(
    initialAccess,
  );
  const [user, setUser] = useState<User | null>(initialUser);

  const setSession = useCallback((tokens: AuthTokens | null) => {
    if (tokens === null) {
      setAccessToken(undefined);
      setUser(null);
      return;
    }
    setAccessToken(tokens.access_token);
    if (tokens.user) setUser(tokens.user);
  }, []);

  const client = useMemo(() => {
    return createClient({
      url,
      token: initialAccess,
      onTokens: setSession,
    });
  }, [url, initialAccess, setSession]);

  // Keep client token in sync when accessToken state changes (hydrate / login).
  useEffect(() => {
    if (client.accessToken !== accessToken) {
      client.setToken(accessToken);
    }
  }, [client, accessToken]);

  const value = useMemo<LoomupContextValue>(
    () => ({
      client,
      user,
      accessToken,
      setSession,
    }),
    [client, user, accessToken, setSession],
  );

  return (
    <LoomupContext.Provider value={value}>{children}</LoomupContext.Provider>
  );
}

export function useLoomup(): LoomupContextValue {
  const ctx = useContext(LoomupContext);
  if (!ctx) {
    throw new Error("useLoomup must be used within LoomupProvider");
  }
  return ctx;
}
