import { defineEventHandler, setResponseStatus } from "h3";
import { authHandlers } from "../utils.js";

export default defineEventHandler(async (event) => {
  const result = await authHandlers(event).refresh({ event });
  setResponseStatus(event, result.status);
  return result.body;
});
