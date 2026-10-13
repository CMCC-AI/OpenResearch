import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createClientTurnId } from '../src/clientTurnId.ts';

test('HTTP contexts can submit and retry a turn without crypto.randomUUID', () => {
  const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const first = createClientTurnId(httpCrypto);
  const second = createClientTurnId(httpCrypto);
  assert.match(first, /^ct_[a-f0-9]{32}$/);
  assert.notEqual(first, second);
});

test('secure contexts retain UUID based turn identifiers', () => {
  assert.match(createClientTurnId(webcrypto), /^ct_[a-f0-9-]{36}$/);
});
