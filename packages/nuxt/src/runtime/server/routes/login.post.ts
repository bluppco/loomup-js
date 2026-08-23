import { defineEventHandler, readBody, setResponseStatus } from "h3";
import { authHandlers } from "../utils.js";

export default defineEventHandler(async (event) => {
  const body = (await readBody(event).catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const result = await authHandlers(event).login(body, { event });
  setResponseStatus(event, result.status);
  return result.body;
});
