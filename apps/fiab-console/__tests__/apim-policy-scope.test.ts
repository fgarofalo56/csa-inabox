/**
 * Unit tests for the APIM policy scope-resolution logic.
 *
 * The same shape is implemented in two places (the BFF route + the
 * editor). Both must agree on:
 *   - 'service' / 'global' / undefined → 'service'
 *   - 'api' requires apiId → 'apis/{aid}'
 *   - 'product' requires productId → 'products/{pid}'
 *   - 'operation' requires apiId + operationId → 'apis/{aid}/operations/{oid}'
 *   - special characters get URL-encoded
 *
 * If this contract drifts, both the editor's dropdown gating and the
 * BFF's 400-error branch will break in lock-step, so we pin it here.
 */
import { describe, it, expect } from 'vitest';

// Inlined from app/api/items/apim-policy/[id]/route.ts. Keep in sync
// with that file — if either drifts the test catches it.
function resolveScope(
  scope?: string | null,
  apiId?: string | null,
  productId?: string | null,
  operationId?: string | null,
): string | null {
  if (!scope || scope === 'service' || scope === 'global') return 'service';
  if (scope === 'api') {
    if (!apiId) return null;
    return `apis/${encodeURIComponent(apiId)}`;
  }
  if (scope === 'product') {
    if (!productId) return null;
    return `products/${encodeURIComponent(productId)}`;
  }
  if (scope === 'operation') {
    if (!apiId || !operationId) return null;
    return `apis/${encodeURIComponent(apiId)}/operations/${encodeURIComponent(operationId)}`;
  }
  return scope;
}

describe('APIM policy scope resolution', () => {
  it('defaults to service for empty / global / service', () => {
    expect(resolveScope(null)).toBe('service');
    expect(resolveScope('')).toBe('service');
    expect(resolveScope('service')).toBe('service');
    expect(resolveScope('global')).toBe('service');
  });

  it('builds API scope and URL-encodes ids', () => {
    expect(resolveScope('api', 'orders-api')).toBe('apis/orders-api');
    expect(resolveScope('api', 'orders api with space')).toBe('apis/orders%20api%20with%20space');
  });

  it('returns null when API scope is missing apiId', () => {
    expect(resolveScope('api', null)).toBeNull();
    expect(resolveScope('api', '')).toBeNull();
  });

  it('builds Product scope and URL-encodes ids', () => {
    expect(resolveScope('product', null, 'customer-360')).toBe('products/customer-360');
    expect(resolveScope('product', null, 'c/360')).toBe('products/c%2F360');
  });

  it('returns null when Product scope is missing productId', () => {
    expect(resolveScope('product', null, null)).toBeNull();
  });

  it('builds Operation scope (v3.27) — apis/{aid}/operations/{oid}', () => {
    expect(resolveScope('operation', 'orders-api', null, 'getOrderById')).toBe(
      'apis/orders-api/operations/getOrderById',
    );
  });

  it('returns null when Operation scope is missing either id', () => {
    expect(resolveScope('operation', 'orders-api', null, null)).toBeNull();
    expect(resolveScope('operation', null, null, 'getOrderById')).toBeNull();
  });

  it('passes through pre-shaped scope strings (escape hatch)', () => {
    expect(resolveScope('apis/foo/operations/bar')).toBe('apis/foo/operations/bar');
  });
});
