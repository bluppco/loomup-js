/**
 * @loomup/nuxt — Nuxt module for Loomup cookie sessions + composables.
 */

import {
  defineNuxtModule,
  addPlugin,
  addImports,
  addServerHandler,
  addServerPlugin,
  createResolver,
} from "@nuxt/kit";
import type { Nuxt } from "@nuxt/schema";
import type { ModuleOptions } from "./types.js";

export type { ModuleOptions } from "./types.js";

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: "@loomup/nuxt",
    configKey: "loomup",
    compatibility: {
      nuxt: ">=3.0.0",
    },
  },
  defaults: {
    url: "",
    authRoutes: true,
    authBasePath: "/api/auth",
    sessionMiddleware: true,
    skewSeconds: 60,
    exposeAccessToken: true,
  },
  setup(options: ModuleOptions, nuxt: Nuxt) {
    const resolver = createResolver(import.meta.url);

    const url =
      options.url ||
      process.env.LOOMUP_URL ||
      process.env.NUXT_LOOMUP_URL ||
      process.env.NUXT_PUBLIC_LOOMUP_URL ||
      "";

    // Runtime config (server private + public)
    nuxt.options.runtimeConfig = nuxt.options.runtimeConfig || {};
    nuxt.options.runtimeConfig.loomupUrl =
      nuxt.options.runtimeConfig.loomupUrl || url;
    nuxt.options.runtimeConfig.loomupCookies =
      nuxt.options.runtimeConfig.loomupCookies || options.cookies || {};
    nuxt.options.runtimeConfig.loomupExposeAccessToken =
      options.exposeAccessToken !== false;
    nuxt.options.runtimeConfig.loomupSkewSeconds =
      options.skewSeconds ?? 60;
    nuxt.options.runtimeConfig.loomupOAuthCallbackUrl = options.oauthCallbackUrl;
    nuxt.options.runtimeConfig.loomupServiceKey = options.serviceKey;

    nuxt.options.runtimeConfig.public = nuxt.options.runtimeConfig.public || {};
    const pub = nuxt.options.runtimeConfig.public as Record<string, unknown>;
    pub.loomupUrl = pub.loomupUrl || url;
    pub.loomupAuthBasePath = options.authBasePath || "/api/auth";

    // Transpile this package so Nitro/Vite can process runtime files
    nuxt.options.build = nuxt.options.build || {};
    nuxt.options.build.transpile = nuxt.options.build.transpile || [];
    nuxt.options.build.transpile.push("@loomup/nuxt");

    // Client plugin
    addPlugin(resolver.resolve("./runtime/plugin.client.js"));

    // Attach runtimeConfig to event.context for server handlers
    addServerPlugin(resolver.resolve("./runtime/server/plugin.js"));

    // Auto-import composables
    addImports([
      {
        name: "useLoomup",
        from: resolver.resolve("./runtime/composables/useLoomup.js"),
      },
      {
        name: "useLoomupState",
        from: resolver.resolve("./runtime/composables/useLoomup.js"),
      },
      {
        name: "useAuth",
        from: resolver.resolve("./runtime/composables/useAuth.js"),
      },
      {
        name: "useLiveQuery",
        from: resolver.resolve("./runtime/composables/useLiveQuery.js"),
      },
    ]);

    const authBase = (options.authBasePath || "/api/auth").replace(/\/$/, "");

    if (options.authRoutes !== false) {
      addServerHandler({
        route: `${authBase}/login`,
        handler: resolver.resolve("./runtime/server/routes/login.post.js"),
        method: "post",
      });
      addServerHandler({
        route: `${authBase}/register`,
        handler: resolver.resolve("./runtime/server/routes/register.post.js"),
        method: "post",
      });
      addServerHandler({
        route: `${authBase}/logout`,
        handler: resolver.resolve("./runtime/server/routes/logout.post.js"),
        method: "post",
      });
      addServerHandler({
        route: `${authBase}/refresh`,
        handler: resolver.resolve("./runtime/server/routes/refresh.post.js"),
        method: "post",
      });
      addServerHandler({
        route: `${authBase}/session`,
        handler: resolver.resolve("./runtime/server/routes/session.get.js"),
        method: "get",
      });
      addServerHandler({
        route: `${authBase}/oauth/start`,
        handler: resolver.resolve("./runtime/server/routes/oauth-start.post.js"),
        method: "post",
      });
      addServerHandler({
        route: `${authBase}/oauth/callback`,
        handler: resolver.resolve("./runtime/server/routes/oauth-callback.get.js"),
        method: "get",
      });
    }

    if (options.sessionMiddleware !== false) {
      addServerHandler({
        middleware: true,
        handler: resolver.resolve("./runtime/server/middleware/session.js"),
      });
    }
  },
});
