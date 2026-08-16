import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The only two fields this service reads from a delivery. Everything else Linear sends is
 * ignored on purpose: the reconciliation cycle rediscovers all of it from the API anyway, so
 * there is no payload field whose meaning the sync logic depends on.
 */
export type LinearWebhookPayload = {
  type: string;
  webhookTimestamp: number;
};

export type VerifyFailure = 'signature' | 'stale' | 'malformed';

export type VerifyResult =
  | { ok: true; payload: LinearWebhookPayload }
  | { ok: false; reason: VerifyFailure };

/** Linear sends a bare lowercase hex HMAC-SHA256 digest - no "sha256=" prefix, unlike GitHub. */
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

/** Linear's recommended replay window. Checked in both directions - see below. */
export const REPLAY_WINDOW_MS = 60_000;

function parsePayload(rawBody: Buffer): LinearWebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { type, webhookTimestamp } = parsed as Record<string, unknown>;
  if (typeof type !== 'string' || typeof webhookTimestamp !== 'number') {
    return null;
  }
  if (!Number.isFinite(webhookTimestamp)) {
    return null;
  }
  return { type, webhookTimestamp };
}

/**
 * Authenticates one delivery (webhook design §5.2, §5.3).
 *
 * Three details here are load-bearing, and each is a real vulnerability if skipped:
 *
 * - The signature is checked against the RAW BYTES, before any parsing. JSON.parse followed by
 *   JSON.stringify does not round-trip byte-for-byte (key order, whitespace, unicode escapes),
 *   so a re-serialized body would not match.
 * - Comparison uses timingSafeEqual. It throws on length mismatch, so length is checked first;
 *   that check is safe to do in variable time because the length is not secret.
 * - Freshness comes from the body's `webhookTimestamp`, NOT the `Linear-Timestamp` header. The
 *   header is not covered by the HMAC, so trusting it would let anyone replaying a captured
 *   body simply rewrite the header to defeat the replay window.
 */
export function verifyDelivery(params: {
  rawBody: Buffer;
  signature: string | undefined;
  secret: string;
  now?: number;
}): VerifyResult {
  const { rawBody, signature, secret } = params;
  const now = params.now ?? Date.now();

  if (signature === undefined || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: 'signature' };
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature' };
  }

  const payload = parsePayload(rawBody);
  if (payload === null) {
    return { ok: false, reason: 'malformed' };
  }

  // Bidirectional: a future-dated timestamp means this container's clock has drifted, which
  // otherwise presents as "every delivery rejected" with no clue as to why.
  if (Math.abs(now - payload.webhookTimestamp) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true, payload };
}
