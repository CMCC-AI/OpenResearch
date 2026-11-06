import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as workspace from "../src/workspaceState.ts";
const source = name => ts.createSourceFile(name, readFileSync(new URL(`../src/${name}`,import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const find=(root,predicate)=>{let result;const visit=node=>{if(result)return;if(predicate(node)){result=node;return;}ts.forEachChild(node,visit);};visit(root);assert.ok(result,"actual entrance must be present");return result;};
const compile=(expression,root,dependencies)=>{
  const code=ts.transpileModule(`exports.action = ${expression.getText(root)}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function("exports",...Object.keys(dependencies),code)(exports,...Object.values(dependencies));return exports.action;
};
test("the actual sidebar SessionRow dispatches both same-project and cross-project clicks through workspace restoration",()=>{
  const root=source("components/ChatPanel.tsx");
  const attribute=find(root,node=>ts.isJsxAttribute(node)&&node.name.getText(root)==="onOpen"&&node.initializer?.getText(root).includes("markDemoSessionRead"));
  for(const target of ["current","other"]){
    const calls=[],direct=[];
    const open=compile(attribute.initializer.expression,root,{project:{id:target},s:{id:"s"},projectId:"current",onActiveSessionChange:(...args)=>calls.push(args),navigate:(args)=>direct.push(args),DEMO_PROJECT_ID:"demo"});
    open();assert.deepEqual(calls,[["s",{projectId:target}]]);assert.deepEqual(direct,[]);
  }
});
function appAction({project="p",active="old",pane={kind:"home",view:"materials"},caseId}={}){
  const root=source("App.tsx");
  const declaration=find(root,node=>ts.isVariableDeclaration(node)&&node.name.getText(root)==="onActiveSessionChange");
  const events=[],opens=[],routes=[];
  const taskDeclaration=find(root,node=>ts.isVariableDeclaration(node)&&node.name.getText(root)==="taskLocation");
  const location=compile(taskDeclaration.initializer,root,{projectTaskLocation:workspace.taskLocation,readOnly:caseId?{caseId,preview:true}:null});
  const action=compile(declaration.initializer.arguments[0],root,{
    router:{navigate:value=>routes.push(value)},projectId:project,activeSessionId:active,
    captureWorkspace:()=>events.push("capture"),inheritNewTaskWorkspace:(...args)=>events.push(["inherit",...args]),
    sessionNavigation:{cancel:()=>events.push("cancel"),open:(...args)=>opens.push(args)},
    taskLocation:location,navigationRef:{current:{pane}},
    isDemoProjectId:()=>false,defaultTaskWorkspace:()=>undefined,tourCompletedRef:{current:true},
  });
  return {action,events,opens,routes,pane};
}
test("the actual App handler preserves an explicit pane and new-session workspace promotion",()=>{
  const f=appAction({active:null});f.action("created",{replace:true});
  assert.deepEqual(f.events,["capture",["inherit","p","created"],"cancel"]);assert.deepEqual(f.opens,[]);
  assert.equal(f.routes[0].replace,true);assert.deepEqual(workspace.parsePane(JSON.parse(new URL(f.routes[0].href,"http://localhost").searchParams.get("pane"))),f.pane);
  const other=appAction();other.action("s",{preservePane:true});assert.deepEqual(other.opens,[]);assert.equal(other.routes.length,1);
});
test("the actual App handler restores the target project's pane without reusing the source pane or cross-project replace",()=>{
  const f=appAction();f.action("s",{projectId:"other",replace:true,preservePane:true});
  assert.deepEqual(f.events,[]);assert.equal(f.routes.length,0);assert.equal(f.opens.length,1);
  const [project,id,commit]=f.opens[0];assert.equal(project,"other");assert.equal(id,"s");
  commit({kind:"side",sessionId:"saved-side"});assert.equal(f.routes[0].replace,false);
  assert.equal(f.routes[0].href,workspace.taskLocation("other","s",{kind:"side",sessionId:"saved-side"}));
});

test("the actual App task wrapper retains case and preview routes during session restoration",()=>{
  const f=appAction({caseId:"read-only-case"});f.action("s",{projectId:"case-project"});f.opens[0][2]({kind:"side",sessionId:"case-side"});
  const url=new URL(f.routes[0].href,"http://localhost");assert.equal(url.pathname,"/cases/read-only-case");assert.equal(url.searchParams.get("preview"),"true");assert.equal(url.searchParams.get("session"),"s");assert.deepEqual(JSON.parse(url.searchParams.get("pane")),{kind:"side",sessionId:"case-side"});
});
