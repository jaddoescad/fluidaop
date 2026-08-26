import assert from 'node:assert/strict';
import test from 'node:test';
import { isUuid } from './identifiers.js';

test('accepts RFC-generated and deterministic PostgreSQL UUIDs', () => {
  assert.equal(isUuid('9c57a9e0-7c46-4c52-8f0f-a11505830d9f'), true);
  assert.equal(isUuid('ad25ce38-3a24-d414-ff2a-dff3b07a4828'), true);
});

test('rejects malformed UUID values', () => {
  assert.equal(isUuid('ad25ce38-3a24-d414-ff2a-dff3b07a482'), false);
  assert.equal(isUuid('ad25ce38-3a24-d414-ff2a-dff3b07a482z'), false);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(null), false);
});
