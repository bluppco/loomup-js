import { defineEventHandler, getQuery, sendRedirect, setResponseStatus } from "h3";
import { authHandlers } from "../utils.js";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const result = await authHandlers(event).oauthCallback(
    typeof query.code === "string" ? query.code : undefined,
    typeof query.error === "string" ? query.error : undefined,
    { event },
  );
  if (result.location) return sendRedirect(event, result.location, result.status);
  setResponseStatus(event, result.status);
  return result.body;
});
