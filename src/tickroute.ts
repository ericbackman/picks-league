// The optional authenticated POST /tick route: an external scheduler can drive
// the tick instead of the cron trigger. Why it exists: the Workers Free plan caps
// cron triggers at 5 per ACCOUNT, so someone running several Workers may prefer
// one scheduler Worker that fans out to each of them over a service binding.
// Inert until the TICK_KEY secret is set; it fails CLOSED, never open.
//
// Answers 202 IMMEDIATELY and does the work in ctx.waitUntil, so a caller never
// waits on a slow tick and the work runs on this Worker's own CPU budget.

/** Constant-time string compare, so the key can't be recovered by timing. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // timingSafeEqual throws on length mismatch, so the length check must come
  // first — length is not the secret, the bytes are.
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

/**
 * Handle POST /tick. Returns null if this request isn't a tick call, so the
 * caller can fall through to its own routing.
 */
export function handleTickRoute(
  request: Request,
  url: URL,
  tickKey: string | undefined,
  runTick: () => Promise<void>,
  ctx: ExecutionContext
): Response | null {
  if (url.pathname !== "/tick") return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Fail CLOSED: an unset TICK_KEY must reject every call, never accept every
  // call. A misconfigured deploy should look broken, not look open.
  if (!tickKey) {
    console.error("/tick called but TICK_KEY is unset — rejecting");
    return new Response("tick not configured", { status: 503 });
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (!secretsMatch(auth, `Bearer ${tickKey}`)) {
    return new Response("unauthorized", { status: 401 });
  }

  ctx.waitUntil(runTick().catch((err) => console.error("tick failed:", err)));
  return new Response("tick dispatched", { status: 202 });
}
