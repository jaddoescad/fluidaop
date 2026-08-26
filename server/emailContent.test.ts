import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmailContent } from './emailContent.js';

test('separates the latest Gmail reply from quoted history and signature', () => {
  const parsed = parseEmailContent([
    'Hi! Yay - amazing news! Thanks so much!',
    '',
    'Still on for the week of October 18? :)',
    '',
    'Thanks!',
    'Chris',
    '',
    'On Tue, Aug 25, 2026 at 8:13 PM Ottawa Painters <info@paintersottawa.com> wrote:',
    '> Good News is that the owners agreed to apply the promotion.',
  ].join('\n'));

  assert.match(parsed.currentMessageText, /Still on for the week of October 18/);
  assert.doesNotMatch(parsed.currentMessageText, /owners agreed/);
  assert.match(parsed.quotedText ?? '', /owners agreed/);
  assert.equal(parsed.hasQuotedContent, true);
});

test('keeps a new message intact when it has no reply history', () => {
  const parsed = parseEmailContent('Can you send the invoice before Friday?');
  assert.equal(parsed.currentMessageText, 'Can you send the invoice before Friday?');
  assert.equal(parsed.quotedText, null);
});
