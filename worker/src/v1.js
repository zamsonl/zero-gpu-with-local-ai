// Router for the /v1 JSON API.

import { hasRelayKey } from "./auth.js";
import { agentStep } from "./agent.js";
import * as chats from "./chats.js";
import { settings } from "./config.js";
import { HttpError, errorJson, json, notFound, badRequest, readJsonObject } from "./http.js";
import { readLiveReply } from "./live.js";
import { requestStop } from "./lock.js";
import { getSettings, putSettings } from "./preferences.js";
import { requestShutdown } from "./server-control.js";
import { startServer } from "./kaggle.js";
import { serverLog } from "./server-log.js";
import { getConfig, getStatus } from "./status.js";
import { turn } from "./turn.js";
import { continueReply } from "./continue.js";
import { previewContext } from "./context.js";
import { compactSession } from "./compact.js";
import { getSessionMemory } from "./session-memory.js";
import { createLongInput, listLongInputs, longInputSource, runLongInput } from "./long-input.js";
import { createImage, deleteImage, getImage, imageFile, listImages, requestMode } from "./images.js";

const CHAT = "/v1/chats/(?<id>[A-Za-z0-9_-]{1,64})";
const IMAGE = "/v1/images/(?<id>[A-Za-z0-9_-]{1,64})";

const ROUTES = [
  ["POST", "/v1/agent/step", agentStep],
  ["GET", "/v1/config", getConfig],
  ["GET", "/v1/status", getStatus],
  ["POST", "/v1/context", previewContext],
  ["POST", "/v1/stop", stopGeneration],
  ["POST", "/v1/server/start", startServer],
  ["GET", "/v1/server/log", serverLog],
  ["POST", "/v1/server/shutdown", requestShutdown],
  ["POST", "/v1/server/mode", requestMode],
  ["GET", "/v1/images", listImages],
  ["POST", "/v1/images", createImage],
  ["GET", IMAGE, getImage],
  ["DELETE", IMAGE, deleteImage],
  ["GET", `${IMAGE}/file`, imageFile],
  ["GET", "/v1/settings", getSettings],
  ["PUT", "/v1/settings", putSettings],
  ["GET", "/v1/chats", chats.listChats],
  ["POST", "/v1/chats", chats.createChat],
  ["POST", "/v1/import", chats.importChatsHandler],
  ["GET", CHAT, chats.getChat],
  ["PATCH", CHAT, chats.renameChat],
  ["DELETE", CHAT, chats.deleteChat],
  ["GET", `${CHAT}/export`, chats.exportChat],
  ["GET", `${CHAT}/live`, liveReply],
  ["POST", `${CHAT}/context`, previewContext],
  ["POST", `${CHAT}/compact`, compactSession],
  ["GET", `${CHAT}/memory`, getSessionMemory],
  ["POST", `${CHAT}/long-inputs`, createLongInput],
  ["GET", `${CHAT}/long-inputs`, listLongInputs],
  ["GET", `${CHAT}/long-inputs/(?<source_id>[A-Za-z0-9_-]{1,64})/source`, longInputSource],
  ["POST", `${CHAT}/long-inputs/(?<source_id>[A-Za-z0-9_-]{1,64})/run`, runLongInput],
  ["POST", `${CHAT}/turn`, turn],
  ["POST", `${CHAT}/continue`, continueReply],
].map(([method, path, handler]) => ({ method, pattern: new RegExp(`^${path}$`), handler }));

/** GET /v1/chats/:id/live: the reply being generated in this chat so far, or null. */
async function liveReply({ env, params }) {
  return json({ live: await readLiveReply(env.DB, params.id) });
}

/** POST /v1/stop: stops the reply being generated, from whichever device started it. */
async function stopGeneration({ env, request }) {
  let scope = {};
  if (request.body) {
    const body = await readJsonObject(request, 1024, { allowEmpty: true });
    if (Object.keys(body).length && (typeof body.generation_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.generation_id)
      || typeof body.chat_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.chat_id))) throw badRequest('A scoped stop needs a valid generation_id and chat_id.');
    if (Object.keys(body).length) scope = { generationId: body.generation_id, chatId: body.chat_id };
  }
  return json(await requestStop(env.DB, scope));
}

export async function handleV1(request, env, ctx, url) {
  try {
    const { authMode, relayKey } = settings(env);
    if (authMode === "key" && !(await hasRelayKey(request, relayKey))) {
      throw new HttpError(401, "unauthorized", "Missing or wrong x-relay-key header.");
    }
    for (const route of ROUTES) {
      const match = route.method === request.method && route.pattern.exec(url.pathname);
      if (match) return await route.handler({ request, env, ctx, url, params: match.groups ?? {} });
    }
    throw notFound("No such endpoint.");
  } catch (err) {
    if (err instanceof HttpError) return errorJson(err);
    console.error(`${request.method} ${url.pathname} failed:`, err);
    return errorJson(new HttpError(500, "internal", "Something went wrong on the server."));
  }
}
