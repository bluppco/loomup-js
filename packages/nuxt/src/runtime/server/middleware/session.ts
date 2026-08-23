/**
 * Nitro middleware: proactive access token refresh.
 * Registered by the @loomup/nuxt module when sessionMiddleware is true.
 */

import { defineEventHandler } from "h3";
import { runSessionUpdate } from "../utils.js";

export default defineEventHandler(async (event) => {
  // Skip static-ish paths lightly; Nitro already skips most assets.
  const path = event.path || "";
  if (
    path.startsWith("/_nuxt") ||
    path.startsWith("/__nuxt") ||
    path.includes(".")
  ) {
    return;
  }
  try {
    await runSessionUpdate(event);
  } catch {
    // Never block the request on session middleware failure.
  }
});
