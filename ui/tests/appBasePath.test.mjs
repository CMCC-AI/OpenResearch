import assert from 'node:assert/strict';
import test from 'node:test';
import {appBaseFor, stripAppBase} from '../src/appBasePath.ts';
import {parseDestination, safeLocation} from '../src/workspaceState.ts';
test('SONA prefix preserves task restore and rejects hidden settings', () => {
  assert.deepEqual(parseDestination('/sona/projects/p/tasks/chat_1'), parseDestination('/projects/p/tasks/chat_1'));
  assert.equal(parseDestination('/sona/projects/p/settings/env'), null);
  assert.equal(safeLocation('/sona/projects/p/tasks/chat_1'), '/sona/projects/p/tasks/chat_1');
});
test('root and sibling applications retain their paths', () => {
  assert.equal(appBaseFor('/sonata/projects'), '');
  assert.equal(stripAppBase('/projects'), '/projects');
  assert.equal(appBaseFor('/sona/projects'), '/sona');
  assert.equal(stripAppBase('/sona/discover'), '/discover');
});
