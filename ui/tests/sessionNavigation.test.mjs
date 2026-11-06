import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as workspace from "../src/workspaceState.ts";
const code = ts.transpileModule(readFileSync(new URL("../src/sessionNavigation.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
new Function("require", "exports", code)((name) => { assert.equal(name, "./workspaceState"); return workspace; }, exports);
const { createSessionNavigation } = exports;
const settled = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const document = (active) => ({...workspace.emptyProjectWorkspace(),tasks:{s:{active}}});
function fixture() {
  const cache=new Map(),reads=[],writes=[],errors=[],loading=[],commits=[];
  let scope="account-a|/projects";
  const nav=createSessionNavigation({context:()=>scope,cached:id=>cache.get(id),read:(id,signal)=>{const p=deferred();reads.push({id,signal,...p});return p.promise;},remember:(id,value)=>writes.push([id,value]),loading:value=>loading.push(value),failed:error=>errors.push(error)});
  return {cache,reads,writes,errors,loading,commits,nav,scope:(next)=>{scope=next;},open:(id,fallback)=>nav.open(id,"s",pane=>commits.push([id,pane]),fallback)};
}
for (const active of [{kind:"side",sessionId:"side-s"},{kind:"home",view:"research"},{kind:"home",view:"materials"},null]) {
  test(`warm navigation restores ${JSON.stringify(active)} without a read`,()=>{
    const f=fixture();f.cache.set("p",document(active));f.open("p",{kind:"home",view:"files"});
    assert.deepEqual(f.commits,[["p",active]]);assert.equal(f.reads.length,0);
  });
}
test("cold navigation waits for the target workspace and remembers its active pane",async()=>{
  const f=fixture();f.open("p");await settled();assert.equal(f.commits.length,0);assert.equal(f.loading.at(-1),true);
  const saved=document({kind:"side",sessionId:"saved"});f.reads[0].resolve(saved);await settled();
  assert.deepEqual(f.commits,[["p",saved.tasks.s.active]]);assert.deepEqual(f.writes,[["p",saved]]);assert.equal(f.loading.at(-1),false);
});
test("a second click aborts the first read and its late completion cannot replace the target",async()=>{
  const f=fixture();f.open("a");await settled();f.open("b");await settled();assert.equal(f.reads[0].signal.aborted,true);
  f.reads[1].resolve(document({kind:"home",view:"materials"}));await settled();f.reads[0].resolve(document({kind:"home",view:"research"}));await settled();
  assert.deepEqual(f.commits,[["b",{kind:"home",view:"materials"}]]);assert.equal(f.writes.length,1);
});
test("a warm click cancels an earlier cold navigation",async()=>{
  const f=fixture();f.open("cold");await settled();f.cache.set("warm",document(null));f.open("warm");f.reads[0].resolve(document({kind:"side",sessionId:"old"}));await settled();
  assert.deepEqual(f.commits,[["warm",null]]);assert.equal(f.reads[0].signal.aborted,true);assert.equal(f.loading.at(-1),false);
});
for(const context of ["account-b|/projects","account-a|/cases/case","account-a|/projects/other"]){
  test(`changed navigation context rejects an old response: ${context}`,async()=>{
    const f=fixture();f.open("p");await settled();f.scope(context);f.reads[0].resolve(document(null));await settled();
    assert.deepEqual(f.commits,[]);assert.deepEqual(f.writes,[]);assert.equal(f.loading.at(-1),false);
  });
}
test("read failure remains on the current page and a new click retries",async()=>{
  const f=fixture();f.open("p");await settled();f.reads[0].reject(new Error("offline"));await settled();
  assert.equal(f.errors[0].message,"offline");assert.deepEqual(f.commits,[]);assert.equal(f.loading.at(-1),false);
  f.open("p");await settled();f.reads[1].resolve(document(null));await settled();assert.deepEqual(f.commits,[["p",null]]);
});
test("cancelled failures do not show alerts or leave a loading notification",async()=>{
  const f=fixture();f.open("p");await settled();f.nav.cancel();f.reads[0].reject(new Error("old failure"));await settled();
  assert.deepEqual(f.errors,[]);assert.deepEqual(f.commits,[]);assert.equal(f.loading.at(-1),false);
});
test("an absent workspace uses the demo fallback but an explicitly closed task does not",async()=>{
  const f=fixture(),fallback={kind:"side",sessionId:null};f.open("demo",fallback);await settled();f.reads[0].resolve(null);await settled();
  assert.deepEqual(f.commits,[["demo",fallback]]);
  f.cache.set("closed",document(null));f.open("closed",fallback);assert.deepEqual(f.commits.at(-1),["closed",null]);
});
test("a synchronously failing transport clears loading and reports its error",async()=>{
  const errors=[],loading=[];
  const nav=createSessionNavigation({context:()=>"scope",cached:()=>undefined,read:()=>{throw new Error("transport");},remember:()=>{},loading:v=>loading.push(v),failed:e=>errors.push(e)});
  nav.open("p","s",()=>assert.fail("must not navigate"));await settled();assert.equal(errors[0].message,"transport");assert.equal(loading.at(-1),false);
});
