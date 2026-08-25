import { defineEventHandler, readBody, sendRedirect, setResponseStatus } from "h3";
import { authHandlers } from "../utils.js";

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => ({}))) as { provider?: string; returnTo?: string };
  const result = await authHandlers(event).oauthStart(body, { event });
  if (result.location) return sendRedirect(event, result.location, result.status);
  setResponseStatus(event, result.status);
  return result.body;
});
