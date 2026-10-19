import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { snapshotMessages } from "../src/product/caseSnapshot.ts";
import * as markdownTarget from "../src/markdownTarget.ts";
import * as markdownNormalization from "../src/markdownNormalization.ts";
import * as remarkFigures from "../src/remarkFigures.ts";

const require=createRequire(import.meta.url);
function load(path,stubs) {
  const source=readFileSync(new URL(path,import.meta.url),"utf8");
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};new Function("require","exports",code)((name)=>name in stubs?stubs[name]:/\.(svg|png)$/.test(name)?{default:name}:require(name),exports);return exports;
}
const detail={id:"case-1",title:"一个真实项目",summary:"已完成的研究",category:"人工智能",status:"published",revision:1,files:[{id:"file-1",name:"成果.html",size:10,sha256:"abc"}],snapshot:{sessions:[{title:"原有研究会话",messages:[{id:"message-1",parentId:null,role:"assistant",createdAt:1,content:'<script>window.executed=true</script>\n![private](/api/projects/private/file/raw?p=secret)\n工具输出：完整结果'}]}]}};
let mountedWorkspace = null;
const markdown = load("../src/components/Md.tsx", {
  "../paraglide/messages.js": { m: new Proxy({}, {get:(_,key)=>()=>key}) },
  "./ReadOnlyWorkspace": {useReadOnlyWorkspace:()=>null},
  "../i18n": {ltr: value=>value}, "../locale": {useLocale:()=>{}},
  "../syntaxLanguage": {resolveSyntaxLanguage:()=>null}, "../syntaxHighlight": {highlight:()=>[]},
  "../remarkFigures": remarkFigures,
  "../markdownNormalization": markdownNormalization,
  "../tabPreview": {tabOpenGestureHandlers:()=>({})},
  "./ui": {}, "../api": {},
  "./InlineHtmlFigure": {InlineHtmlFigure:()=>{throw Error("No HTML figure in public snapshots")}},
  "./ImageCarousel": {ImageCarousel:({children})=>children,ImageCarouselContext:React.createContext(null)},
  "../imageZoom": {}, "../markdownTarget": markdownTarget,
});
function components(rows=[detail],admin=false,queryResult=null) {
  return load("../src/product/FeaturedCases.tsx",{
    "@tanstack/react-query":{useQuery:()=>queryResult??({data:{cases:rows},isPending:false,error:null})},
    "@tanstack/react-router":{Link:({to,params,children,...props})=>React.createElement("a",{...props,href:params?`/cases/${params.caseId}`:to},children)},
    "./ReadOnlyProject":{ReadOnlyProject:(props)=>{mountedWorkspace=props;return React.createElement("div",{"data-project-workspace":"readonly"},props.id)}},
    "./captureNativeProject":{captureNativeProject:async()=>{throw Error("No live source reads during render")}},
    "./AuthSession":{useAuthSession:()=>({accountUrl:"http://localhost:5300",user:{id:"reader",isAdmin:admin}})},
    "./CloudWorkspace":{isCloudWorkspace:()=>false},
    "./ProductNav":{PlatformFrame:({children})=>children},
    "../components/ui":{Button:({children,...props})=>React.createElement("button",props,children)},
    "./featuredCasesApi":{caseRequest:async()=>({cases:rows}),caseFileBlob:async()=>{throw Error("No download during render")}},
  });
}
test("published cards open the case record, with no template or private project action",()=>{
  const {ResearchCases}=components();const html=renderToStaticMarkup(React.createElement(ResearchCases));
  assert.ok(html.includes('href="/cases/case-1"'));assert.ok(html.includes("一个真实项目"));
  assert.equal(html.includes("填入研究目标"),false);assert.equal(html.includes("从论文到可信复现"),false);assert.equal(html.includes("管理精选案例"),false);
  const empty=components([]);assert.ok(renderToStaticMarkup(React.createElement(empty.ResearchCases)).includes("暂时没有已发布"));
  const admin=components([detail],true);assert.ok(renderToStaticMarkup(React.createElement(admin.ResearchCases)).includes("管理精选案例"));
});
test("case detail mounts the project App in read-only mode with the complete snapshot",()=>{
  const nativeDetail={...detail,snapshot:{...detail.snapshot,workspace:{version:1,projectId:"source",sessionId:"session",responses:{},assets:{}}}};
  const {CaseTranscript}=components();const html=renderToStaticMarkup(React.createElement(CaseTranscript,{detail:nativeDetail}));
  assert.equal(mountedWorkspace.workspace,nativeDetail.snapshot.workspace);assert.equal(mountedWorkspace.id,detail.id);
  assert.ok(html.includes('data-project-workspace="readonly"'));
  assert.equal(html.includes("发送消息"),false);
  const publicPage=components([],false,{data:nativeDetail,error:null,isPending:false});
  assert.ok(renderToStaticMarkup(React.createElement(publicPage.CaseDetailPage,{caseId:detail.id})).includes('data-project-workspace="readonly"'));
});

test("a failed availability recheck hides previously cached case content",()=>{
  const {CaseDetailPage}=components([],false,{data:detail,error:new Error("案例已下架"),isPending:false});
  const html=renderToStaticMarkup(React.createElement(CaseDetailPage,{caseId:detail.id}));
  assert.ok(html.includes("案例已下架"));assert.equal(html.includes("完整结果"),false);assert.equal(html.includes("下载完整文件"),false);
});
test("snapshot capture includes archived and branched chats, refuses active or changing sources",async()=>{
  const rows=[{id:"newer",createdAt:20,updatedAt:20,title:"已归档",archived:true,busy:false},{id:"older",createdAt:10,updatedAt:10,title:"主研究",busy:false}];
  let calls=0;let queued=false;let change=false;
  const api=load("../src/product/featuredCasesApi.ts",{
    "../appBasePath":{appHref:p=>p},"./caseSnapshot":{snapshotMessages},
    "../api":{listExperiments:async()=>[],listRuns:async()=>[],getResearchStudy:async()=>({study:null,runs:[]}),listChatSessions:async()=>{calls++;return change&&calls%2===0?[{...rows[0],updatedAt:999},rows[1]]:rows},getChatMessages:async(id)=>({messages:[{id:"a",role:"user",createdAt:1,parts:[{type:"text",text:`full ${id}`}]},{id:"b",parentId:"a",role:"assistant",createdAt:2,parts:[{type:"text",text:"branch retained"}]}],queued:queued?[{}]:[]})},
  });
  const value=await api.captureProject("authorized-project");assert.deepEqual(value.sessions.map(s=>s.title),["主研究","已归档"]);assert.equal(value.sessions[0].messages.length,2);
  rows[0].busy=true;await assert.rejects(api.captureProject("authorized-project"),/运行中/);rows[0].busy=false;
  queued=true;await assert.rejects(api.captureProject("authorized-project"),/排队/);queued=false;
  calls=0;change=true;await assert.rejects(api.captureProject("authorized-project"),/发生变化/);
});
test("copying source artifacts cancels oversized responses even without Content-Length",async()=>{
  const api=load("../src/product/featuredCasesApi.ts",{"../appBasePath":{appHref:p=>p},"./caseSnapshot":{snapshotMessages},"../api":{}});
  const original=globalThis.fetch;let cancelled=false;
  try {
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(25*1024*1024+1));},cancel(){cancelled=true;}}));
    await assert.rejects(api.sourceFile("/api/projects/authorized/file/raw"),/25 MB/);assert.equal(cancelled,true);
    globalThis.fetch=async()=>new Response(new Uint8Array([0,1,2,255]));assert.deepEqual([...new Uint8Array(await (await api.sourceFile("/api/projects/authorized/file/raw")).arrayBuffer())],[0,1,2,255]);
  } finally {globalThis.fetch=original;}
});

test("public markdown retains native formatting without loading private images or links",()=>{
  const html=renderToStaticMarkup(React.createElement(markdown.Md,{inert:true,text:'## 研究结论\n\n**结果成立**\n\n![private](/api/projects/private/chart.html)\n\n[private](/api/projects/private/file/raw)\n\n<file path="private/results.csv"/> <run id="private-run"/>\n\n<script>dangerous()</script>'}));
  assert.ok(html.includes("<h2"));assert.ok(html.includes("<strong"));assert.ok(html.includes("结果成立"));
  for(const value of ["<img", "<iframe", "<script", 'href="/api/'])assert.equal(html.includes(value),false,value);
});


test("capture preserves project metadata, completion timing and native research links", async()=>{
  const task={id:"task",role:"as-result-analyst",brief:"分析",dependsOn:[],outputs:[],state:"completed",sessionId:"private-expert",artifacts:[],runIds:[]};
  const study={id:"study",sessionId:"private-main",mode:"team",status:"completed",objective:"目标",plans:[{version:1,summary:"计划",tasks:[task]}],decisions:[],claims:[]};
  const sessions=[{id:"private-main",harness:"opencode",title:"主研究",createdAt:1,updatedAt:3,busy:false,archived:false},{id:"private-expert",harness:"opencode",title:"专家",createdAt:2,updatedAt:3,busy:false,archived:true,parentSessionId:"private-main"}];
  const runs=[{id:"run",experimentId:"exp",status:"done",createdAt:1,updatedAt:3,backend:{secret:"private"}}];
  const api=load("../src/product/featuredCasesApi.ts",{"../appBasePath":{},"./caseSnapshot":{snapshotMessages},"../api":{
    listChatSessions:async()=>sessions,listRuns:async()=>runs,listExperiments:async()=>[{id:"exp",projectId:"private-project",chatSessionId:"private-main"}],
    getChatMessages:async()=>({messages:[{id:"original",role:"assistant",createdAt:1,completedAt:3,parts:[{id:"text",type:"text",text:"完整结果"}]}],activeLeafId:"original",queued:[]}),
    getResearchStudy:async(id)=>({study:id==="private-main"?study:null,runs:id==="private-main"?runs:[]}),
  }});
  const result=await api.captureProject("private-project","原项目名");
  assert.equal(result.projectName,"原项目名");assert.equal(result.sessions[0].activeLeafId,"message-1");assert.equal(result.sessions[0].messages[0].completedAt,3);
  assert.equal(result.sessions[0].research.study.plans[0].tasks[0].sessionId,result.sessions[1].id);
  assert.equal(result.sessions[1].parentSessionId,result.sessions[0].id);assert.equal(result.sessions[1].archived,true);assert.equal(result.runs[0].backend,null);
  assert.equal(study.plans[0].tasks[0].sessionId,"private-expert");
  runs[0].status="running";await assert.rejects(api.captureProject("private-project"),/运行中的实验/);
});
