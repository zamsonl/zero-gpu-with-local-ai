// Shared input rules for the /v1 API.

import { badRequest, tooLarge } from "./http.js";

export const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_CONTENT_CHARS = 100_000;
export const TITLE_MAX_CHARS = 80;
export const AUTO_TITLE_CHARS = 60;

/** Trims, collapses whitespace runs to one space and cuts to `max` code points. */
export function normalizeTitle(value, max = TITLE_MAX_CHARS) {
  const points = Array.from(value.replace(/\s+/g, " ").trim());
  return points.length > max ? points.slice(0, max).join("").trimEnd() : points.join("");
}

export function expectString(value, field) {
  if (typeof value !== "string") throw badRequest(`"${field}" must be a string.`);
  return value;
}

export function expectChatId(value, field = "id") {
  if (typeof value !== "string" || !CHAT_ID_PATTERN.test(value)) {
    throw badRequest(`"${field}" must be 1-64 characters of A-Z, a-z, 0-9, "_" or "-".`);
  }
  return value;
}

/** Text of a message: a string of at most MAX_CONTENT_CHARS, non-blank unless `allowEmpty`. */
export function expectContent(value, field, { allowEmpty = false } = {}) {
  expectString(value, field);
  if (!allowEmpty && !value.trim()) throw badRequest(`"${field}" must not be empty.`);
  if (value.length > MAX_CONTENT_CHARS) {
    throw tooLarge(`"${field}" is longer than ${MAX_CONTENT_CHARS} characters.`);
  }
  return value;
}

/** Any date string Date.parse accepts, normalised to ISO 8601 UTC. */
export function expectIsoDate(value, field) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw badRequest(`"${field}" must be an ISO 8601 date.`);
  return new Date(ms).toISOString();
}
