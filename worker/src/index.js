// qwen-relay Worker: the chat API (/v1), the Colab relay (/_relay, /api) and the static web UI.

import { text } from "./http.js";
import { handleRelay } from "./relay.js";
import { withSecurityHeaders } from "./security.js";
import { handleV1 } from "./v1.js";
import { bootstrapAgentSession, routeAgentSession } from "./agent-sessions.js";
import {preparePersonalCache,personalCacheCallback} from './personal-cache.js';

export default {
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      console.error(`${request.method} ${request.url} failed:`, err);
      response = text("internal error\n", 500);
    }
    return withSecurityHeaders(response);
  },
};

function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  // Personal helper bootstrap authenticates the supplied Kaggle token, independently
  // of the owner's chat login. Every following operation uses its isolated session.
  if (pathname === "/v1/agent/sessions" && request.method === "POST") return bootstrapAgentSession({request,env});
  if (pathname === '/v1/agent/cache' && request.method === 'POST') return preparePersonalCache({request,env});
  const cacheRoute=/^\/_agent-cache\/([a-f0-9]{40})\/(?:report|command)$/.exec(pathname);
  if(cacheRoute)return personalCacheCallback({request,env,id:cacheRoute[1]});
  if (pathname.startsWith("/_agent/")) return routeAgentSession(request,env,ctx,url);
  if (pathname === "/v1" || pathname.startsWith("/v1/")) return handleV1(request, env, ctx, url);
  if (pathname.startsWith("/_relay/") || pathname.startsWith("/api/")) return handleRelay(request, env, url, ctx);
  return env.ASSETS.fetch(request);
}
