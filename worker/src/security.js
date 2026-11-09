// Headers stamped onto every response the Worker sends, static assets included.

const BASE_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function withSecurityHeaders(response) {
  // Responses from fetch() and env.ASSETS have immutable headers; copy into a mutable response.
  // The body stream is handed over as is, so streaming responses keep streaming.
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(BASE_HEADERS)) out.headers.set(name, value);
  if ((out.headers.get("content-type") || "").toLowerCase().startsWith("text/html")) {
    out.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  return out;
}
