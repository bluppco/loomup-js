import {
  LoomupError,
  type AuthTokens,
  type LoomupClient,
  type OAuthProvider,
} from "@loomup/client";

function callbackTarget(value: string): string {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
}

/** Launches a system authentication session and resolves with its callback URL. */
export type OAuthSessionLauncher = (
  authorizationUrl: string,
  redirectTo: string,
) => Promise<string>;

export type NativeOAuthSignInOptions = {
  provider: OAuthProvider;
  redirectTo: string;
  openAuthSession: OAuthSessionLauncher;
};

/**
 * Complete one OAuth flow without persisting the short-lived verifier. Works
 * with Expo WebBrowser/AuthSession, react-native-inappbrowser, or an app-owned
 * deep-link launcher.
 */
export async function signInWithOAuth(
  client: LoomupClient,
  options: NativeOAuthSignInOptions,
): Promise<AuthTokens> {
  const authorization = await client.auth.authorizeOAuth({
    provider: options.provider,
    redirectTo: options.redirectTo,
  });
  const callback = await options.openAuthSession(
    authorization.authorization_url,
    options.redirectTo,
  );
  const url = new URL(callback);
  if (callbackTarget(callback) !== callbackTarget(options.redirectTo)) {
    throw new LoomupError(
      "OAuth callback does not match redirectTo",
      "oauth_callback_mismatch",
    );
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    throw new LoomupError(
      `OAuth sign-in failed: ${providerError}`,
      providerError,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new LoomupError(
      "OAuth callback did not include a code",
      "oauth_callback_incomplete",
    );
  }
  return client.auth.exchangeOAuthCode({
    code,
    codeVerifier: authorization.code_verifier,
  });
}
