import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingOAuthAuthorizations,
  StaleOAuthAuthorizationError,
} from './oauthAuthorizationPolicy.js';

test('disconnect before callback consumption removes the pending authorization', () => {
  const authorizations = new PendingOAuthAuthorizations<{ verifier: string }>();
  authorizations.begin('state-1', 'gmail:info@example.com', 100, { verifier: 'secret' });

  authorizations.cancel('gmail:info@example.com');

  assert.equal(authorizations.consume('state-1'), undefined);
});

test('disconnect during an in-flight callback invalidates its claimed generation', () => {
  const authorizations = new PendingOAuthAuthorizations<{ verifier: string }>();
  authorizations.begin('state-1', 'gmail:info@example.com', 100, { verifier: 'secret' });
  const claimed = authorizations.consume('state-1');
  assert.ok(claimed);

  authorizations.cancel('gmail:info@example.com');

  assert.throws(
    () => authorizations.assertCurrent(claimed),
    StaleOAuthAuthorizationError,
  );
});

test('a new explicit authorization supersedes an older callback', () => {
  const authorizations = new PendingOAuthAuthorizations<{ verifier: string }>();
  authorizations.begin('old-state', 'gmail:info@example.com', 100, { verifier: 'old' });
  const latest = authorizations.begin(
    'new-state',
    'gmail:info@example.com',
    200,
    { verifier: 'new' },
  );

  assert.equal(authorizations.consume('old-state'), undefined);
  authorizations.assertCurrent(latest);
});

test('expired pending authorizations are pruned', () => {
  const authorizations = new PendingOAuthAuthorizations<{ verifier: string }>();
  authorizations.begin('expired', 'gmail:info@example.com', 99, { verifier: 'secret' });
  authorizations.pruneExpired(100);
  assert.equal(authorizations.consume('expired'), undefined);
});
