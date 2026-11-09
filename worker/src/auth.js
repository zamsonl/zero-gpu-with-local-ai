const encoder = new TextEncoder();

/**
 * Constant-time check of the `x-relay-key` header. Both sides are hashed first so the comparison
 * runs over equal-length buffers and leaks neither content nor length.
 */
export async function hasRelayKey(request, relayKey) {
  if (!relayKey) return false;
  const given = request.headers.get("x-relay-key") ?? "";
  const [a, b] = await Promise.all([digest(given), digest(relayKey)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function digest(value) {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}
