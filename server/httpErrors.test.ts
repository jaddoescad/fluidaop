import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyParserHttpError } from './httpErrors.js';

test('body parser payload limits remain a 413 response', () => {
  assert.deepEqual(bodyParserHttpError({ status: 413, type: 'entity.too.large' }), {
    status: 413,
    message: 'Request body is too large',
  });
});

test('malformed JSON remains a 400 response without leaking parser details', () => {
  assert.deepEqual(bodyParserHttpError({ status: 400, body: '{secret' }), {
    status: 400,
    message: 'Request body contains invalid JSON',
  });
  assert.equal(bodyParserHttpError(new Error('boom')), null);
});
