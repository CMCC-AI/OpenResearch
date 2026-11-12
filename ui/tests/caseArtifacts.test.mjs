import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedArtifactPaths, selectedCaseArtifacts, artifactSelectionSummary } from '../src/product/caseArtifacts.ts';
const root = 'research/study/paper';
const file = (path, size=5) => ({name:path.split('/').at(-1), path, size, isDir:false});
const listing = entries => ({scope:'conversation-results',sessionId:'s',dir:'/results',truncated:false,roots:[{path:'research/study',title:'Study'}],entries});
test('selected exports normalize overlapping paths and copy only explicitly selected trees', async () => {
  assert.deepEqual(selectedArtifactPaths([root+'/report.md', root, root]), [root]);
  for (const path of ['/etc/passwd','../data','research/../private','a\\b','a//b']) assert.throws(() => selectedArtifactPaths([path]));
  const reads = [];
  const request = async url => { reads.push(new URL(url,'http://local')); return Response.json(listing([{name:'paper',path:root,isDir:true,size:0,children:[file(root+'/report.md')]}])); };
  const selected = await selectedCaseArtifacts('p','s',[root],request);
  assert.deepEqual(artifactSelectionSummary(selected), {files:1,bytes:5});
  assert.equal(reads[0].searchParams.get('path'),root);
  assert.equal(reads[0].searchParams.get('recursive'),'true');
  assert.deepEqual((await selectedCaseArtifacts('p','s',[],request)).entries,[]);
  assert.equal(reads[1].searchParams.get('recursive'),'false');
});
test('selected exports reject foreign entries, incomplete listings and excess data without a full project fallback', async () => {
  const request = value => async url => {assert.match(url,/\/case-artifacts\?/);return Response.json(value);};
  await assert.rejects(selectedCaseArtifacts('p','s',[root],request(listing([file('research/other/private.csv')]))), /未勾选/);
  await assert.rejects(selectedCaseArtifacts('p','s',[root],request({...listing([]),truncated:true})), /未读取完整/);
  await assert.rejects(selectedCaseArtifacts('p','s',[root],request(listing([file(root+'/big.parquet',513*1024*1024)]))), /512 MiB/);
  await assert.rejects(selectedCaseArtifacts('p','s',[root],request(listing(Array.from({length:2001},(_,n)=>file(`${root}/${n}`))))), /2,000/);
  await assert.rejects(selectedCaseArtifacts('p','s',[root],async () => new Response('{}',{status:404})), /更新执行器/);
});
