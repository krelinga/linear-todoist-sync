import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPLAY_WINDOW_MS, verifyDelivery } from '../../src/webhook/verify.js';

const SECRET = 'lin_wh_test_secret';
const NOW = Date.parse('2026-08-16T12:00:00.000Z');

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
}

function delivery(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    webhookTimestamp: NOW,
    data: { id: 'abc', title: 'Fix the flaky login test' },
    ...overrides,
  });
}

function verify(body: string, signature: string | undefined, now = NOW) {
  return verifyDelivery({ rawBody: Buffer.from(body, 'utf8'), signature, secret: SECRET, now });
}

describe('verifyDelivery', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const body = delivery();
    const result = verify(body, sign(body));
    expect(result).toEqual({ ok: true, payload: { type: 'Issue', webhookTimestamp: NOW } });
  });

  it('rejects a delivery with no signature header', () => {
    expect(verify(delivery(), undefined)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = delivery();
    expect(verify(body, sign(body, 'not-the-secret'))).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a body tampered with after signing', () => {
    const signature = sign(delivery());
    const tampered = delivery({ type: 'Comment' });
    expect(verify(tampered, signature)).toEqual({ ok: false, reason: 'signature' });
  });

  // Byte-exactness matters: re-serializing a parsed body changes key order and spacing, so a
  // signature computed over the original will not match. This pins that we use the raw bytes.
  it('rejects a semantically identical body that was re-serialized', () => {
    const original = `{ "type": "Issue", "webhookTimestamp": ${NOW} }`;
    const reserialized = JSON.stringify(JSON.parse(original));
    expect(reserialized).not.toBe(original); // whitespace is not preserved
    expect(JSON.parse(reserialized)).toEqual(JSON.parse(original)); // but the meaning is
    expect(verify(reserialized, sign(original))).toEqual({ ok: false, reason: 'signature' });
  });

  it.each([
    ['non-hex', 'z'.repeat(64)],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(128)],
    ['empty', ''],
    ['github-style prefixed', `sha256=${'a'.repeat(64)}`],
  ])('rejects a %s signature without throwing', (_label, signature) => {
    expect(verify(delivery(), signature)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects a delivery older than the replay window', () => {
    const body = delivery({ webhookTimestamp: NOW - REPLAY_WINDOW_MS - 1 });
    expect(verify(body, sign(body))).toEqual({ ok: false, reason: 'stale' });
  });

  // Catches container clock skew, which would otherwise look like a mysterious total outage.
  it('rejects a delivery dated too far in the future', () => {
    const body = delivery({ webhookTimestamp: NOW + REPLAY_WINDOW_MS + 1 });
    expect(verify(body, sign(body))).toEqual({ ok: false, reason: 'stale' });
  });

  it('accepts a delivery exactly at the edge of the window', () => {
    const body = delivery({ webhookTimestamp: NOW - REPLAY_WINDOW_MS });
    expect(verify(body, sign(body))).toMatchObject({ ok: true });
  });

  it.each([
    ['invalid JSON', 'not json at all'],
    ['a JSON scalar', '"just-a-string"'],
    ['null', 'null'],
    ['a missing type', JSON.stringify({ webhookTimestamp: NOW })],
    ['a missing webhookTimestamp', JSON.stringify({ type: 'Issue' })],
    ['a non-numeric webhookTimestamp', JSON.stringify({ type: 'Issue', webhookTimestamp: 'now' })],
  ])('reports %s as malformed once the signature checks out', (_label, body) => {
    expect(verify(body, sign(body))).toEqual({ ok: false, reason: 'malformed' });
  });

  // Signature is checked before parsing, so an unsigned malformed body is a signature failure -
  // an attacker learns nothing about parsing from an unauthenticated request.
  it('reports an unsigned malformed body as a signature failure, not malformed', () => {
    expect(verify('not json at all', undefined)).toEqual({ ok: false, reason: 'signature' });
  });
});
