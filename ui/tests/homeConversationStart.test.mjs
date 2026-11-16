import assert from 'node:assert/strict';
import test from 'node:test';
import { canStartQuestionDirectly, submitHomeQuestion } from '../src/homeConversationStart.ts';
const attempt = { session: { id: 's' }, clientTurnId: 'ct_same', options: { model: 'fixture/model' }, signature: 'question' };
const draft = { draft: 'question', attachments: [], annotations: [] };
test('plain questions start before navigation; commands and uploads retain composer semantics', () => {
  assert.equal(canStartQuestionDirectly(draft), true);
  for (const value of [{ draft: ' /plan question' }, { draft: '!pwd' }, { draft: ' ' }, { attachments: [{}] }, { annotations: [{}] }])
    assert.equal(canStartQuestionDirectly({ ...draft, ...value }), false);
});
test('a lost send response is accepted only with the matching durable receipt', async () => {
  const lost = new Error('response lost');
  const saved = { sessionId: 's', clientTurnId: 'ct_same', submission: { kind: 'turn', id: 'stored' } };
  const run = receipt => submitHomeQuestion(attempt, 'question', { send: async () => { throw lost; }, receipt: async () => receipt, isCurrent: () => true });
  await run(saved);
  for (const other of [null, { ...saved, sessionId: 'other' }, { ...saved, clientTurnId: 'other' }, { ...saved, submission: null }])
    await assert.rejects(run(other), error => error === lost);
});
test('retry keeps the same session, request identity, question and settings', async () => {
  const calls = [];
  const deps = { isCurrent: () => true, receipt: async () => null, send: async (...args) => {
    calls.push(args); if (calls.length === 1) throw Error('offline');
  } };
  await assert.rejects(submitHomeQuestion(attempt, ' question ', deps), /offline/);
  await submitHomeQuestion(attempt, ' question ', deps);
  assert.deepEqual(calls, [['s', 'question', attempt.options, 'ct_same'], ['s', 'question', attempt.options, 'ct_same']]);
});
test('a workspace change cannot send or accept the old question', async () => {
  await assert.rejects(submitHomeQuestion(attempt, 'question', { isCurrent: () => false,
    send: () => assert.fail('must not send'), receipt: () => assert.fail('must not read') }), { name: 'AbortError' });
});
