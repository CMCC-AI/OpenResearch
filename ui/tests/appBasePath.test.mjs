import assert from 'node:assert/strict';
import test from 'node:test';
import {appBaseFor, stripAppBase} from '../src/appBasePath.ts';
import {parseDestination, safeLocation} from '../src/workspaceState.ts';
test('MobileSci prefix preserves task restore and rejects hidden settings', () => {
  assert.deepEqual(parseDestination('/mobilesci/projects/p/tasks/chat_1'), parseDestination('/projects/p/tasks/chat_1'));
  assert.equal(parseDestination('/mobilesci/projects/p/settings/env'), null);
  assert.equal(safeLocation('/mobilesci/projects/p/tasks/chat_1'), '/mobilesci/projects/p/tasks/chat_1');
});
test('root and sibling applications retain their paths', () => {
  assert.equal(appBaseFor('/sonata/projects'), '');
  assert.equal(stripAppBase('/projects'), '/projects');
  assert.equal(appBaseFor('/mobilesci/projects'), '/mobilesci');
  assert.equal(stripAppBase('/mobilesci/discover'), '/discover');
});
