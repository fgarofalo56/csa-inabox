/**
 * Unit tests for the pure Avro structural compatibility validator.
 * No Azure credentials / I/O — exercises the exact EH SR / Confluent rules.
 */
import { describe, it, expect } from 'vitest';
import { checkAvroCompat } from '../schema-compat-validator';

const record = (fields: unknown[]) =>
  JSON.stringify({ type: 'record', name: 'Ev', namespace: 'loom', fields });

const f = (name: string, type: unknown, def?: unknown) =>
  def === undefined ? { name, type } : { name, type, default: def };

describe('checkAvroCompat', () => {
  describe('BACKWARD', () => {
    it('allows deleting a field', () => {
      const oldS = record([f('a', 'string'), f('b', 'int')]);
      const newS = record([f('a', 'string')]);
      const r = checkAvroCompat(oldS, newS, 'BACKWARD');
      expect(r.compatible).toBe(true);
      expect(r.violations).toEqual([]);
    });

    it('allows adding a field WITH a default', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'string'), f('b', 'int', 0)]);
      expect(checkAvroCompat(oldS, newS, 'BACKWARD').compatible).toBe(true);
    });

    it('blocks adding a field WITHOUT a default', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'string'), f('b', 'int')]);
      const r = checkAvroCompat(oldS, newS, 'BACKWARD');
      expect(r.compatible).toBe(false);
      expect(r.violations.join(' ')).toMatch(/'b'.*added without a default/i);
    });
  });

  describe('FORWARD', () => {
    it('allows adding a field (with or without default)', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'string'), f('b', 'int')]);
      expect(checkAvroCompat(oldS, newS, 'FORWARD').compatible).toBe(true);
    });

    it('allows deleting a field that HAD a default', () => {
      const oldS = record([f('a', 'string'), f('b', 'int', 0)]);
      const newS = record([f('a', 'string')]);
      expect(checkAvroCompat(oldS, newS, 'FORWARD').compatible).toBe(true);
    });

    it('blocks deleting a field that had NO default', () => {
      const oldS = record([f('a', 'string'), f('b', 'int')]);
      const newS = record([f('a', 'string')]);
      const r = checkAvroCompat(oldS, newS, 'FORWARD');
      expect(r.compatible).toBe(false);
      expect(r.violations.join(' ')).toMatch(/'b'.*removed/i);
    });
  });

  describe('FULL', () => {
    it('passes for a no-op change', () => {
      const s = record([f('a', 'string'), f('b', 'int')]);
      expect(checkAvroCompat(s, s, 'FULL').compatible).toBe(true);
    });

    it('blocks adding a field without a default (fails BACKWARD half)', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'string'), f('b', 'int')]);
      expect(checkAvroCompat(oldS, newS, 'FULL').compatible).toBe(false);
    });

    it('allows adding a field with a default', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'string'), f('b', 'int', 0)]);
      expect(checkAvroCompat(oldS, newS, 'FULL').compatible).toBe(true);
    });
  });

  describe('type changes', () => {
    it('allows int -> long (promotable) under BACKWARD', () => {
      const oldS = record([f('n', 'int')]);
      const newS = record([f('n', 'long')]);
      expect(checkAvroCompat(oldS, newS, 'BACKWARD').compatible).toBe(true);
    });

    it('blocks string -> int (not promotable) under BACKWARD', () => {
      const oldS = record([f('n', 'string')]);
      const newS = record([f('n', 'int')]);
      const r = checkAvroCompat(oldS, newS, 'BACKWARD');
      expect(r.compatible).toBe(false);
      expect(r.violations.join(' ')).toMatch(/changed type/i);
    });

    it('blocks int -> long under FORWARD (long does not promote back to int)', () => {
      const oldS = record([f('n', 'int')]);
      const newS = record([f('n', 'long')]);
      expect(checkAvroCompat(oldS, newS, 'FORWARD').compatible).toBe(false);
    });
  });

  describe('NONE', () => {
    it('always passes regardless of change', () => {
      const oldS = record([f('a', 'string')]);
      const newS = record([f('a', 'int')]);
      expect(checkAvroCompat(oldS, newS, 'NONE').compatible).toBe(true);
    });
  });

  describe('non-Avro formats', () => {
    it('JSON format always compatible (EH SR does not evolution-check)', () => {
      const oldS = JSON.stringify({ properties: { a: { type: 'string' } } });
      const newS = JSON.stringify({ properties: {} });
      expect(checkAvroCompat(oldS, newS, 'BACKWARD', 'JSON').compatible).toBe(true);
    });

    it('PROTOBUF format always compatible', () => {
      expect(checkAvroCompat('syntax="proto3";', 'syntax="proto3";', 'FULL', 'PROTOBUF').compatible).toBe(true);
    });
  });

  describe('invalid JSON', () => {
    it('reports a violation when the new schema is not valid JSON', () => {
      const oldS = record([f('a', 'string')]);
      const r = checkAvroCompat(oldS, '{ not json', 'BACKWARD');
      expect(r.compatible).toBe(false);
      expect(r.violations.join(' ')).toMatch(/not valid JSON/i);
    });
  });
});
