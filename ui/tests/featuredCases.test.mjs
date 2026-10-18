import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { snapshotMessages } from "../src/product/caseSnapshot.ts";

const require=createRequire(import.meta.url);
function load(path,stubs) {
  const source=readFileSync(new URL(path,import.meta.url),"utf8");
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};new Function("require","exports",code)((name)=>name in stubs?stubs[name]:require(name),exports);return exports;
}
const detail={id:"case-1",title:"一个真实项目",summary:"已完成的研究",category:"人工智能",status:"published",revision:1,files:[{id:"file-1",name:"成果.html",size:10,sha256:"abc"}],snapshot:{sessions:[{title:"原有研究会话",messages:[{id:"message-1",parentId:null,role:"assistant",createdAt:1,content:'<script>window.executed=true</script>\n![private](/api/projects/private/file/raw?p=secret)\n工具输出：完整结果'}]}]}};
function components(rows=[detail],admin=false,queryResult=null) {
  return load("../src/product/FeaturedCases.tsx",{
    "@tanstack/react-query":{useQuery:()=>queryResult??({data:{cases:rows},isPending:false,error:null})},
    "@tanstack/react-router":{Link:({to,params,children,...props})=>React.createElement("a",{...props,href:params?`/cases/${params.caseId}`:to},children)},
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
  assert.equal(html.includes("填入研究目标"),false);assert.equal(html.includes("从论文到可信复现"),false);assert.equal(html.includes("管理案例"),false);
  const empty=components([]);assert.ok(renderToStaticMarkup(React.createElement(empty.ResearchCases)).includes("暂时没有已发布"));
  const admin=components([detail],true);assert.ok(renderToStaticMarkup(React.createElement(admin.ResearchCases)).includes("管理案例"));
});
test("the public transcript renders every record as inert text and only offers snapshot downloads",()=>{
  const {CaseTranscript}=components();const html=renderToStaticMarkup(React.createElement(CaseTranscript,{detail}));
  assert.ok(html.includes("&lt;script&gt;"));assert.ok(html.includes("完整结果"));assert.ok(html.includes("下载完整文件"));
  assert.equal(html.includes("<script>"),false);assert.equal(html.includes("<iframe"),false);assert.equal(html.includes("<img"),false);
  assert.equal(html.includes('href="/api/projects/'),false);assert.equal(html.includes("发送消息"),false);assert.equal(html.includes("运行实验"),false);
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
    "../api":{listChatSessions:async()=>{calls++;return change&&calls%2===0?[{...rows[0],updatedAt:999},rows[1]]:rows},getChatMessages:async(id)=>({messages:[{id:"a",role:"user",createdAt:1,parts:[{type:"text",text:`full ${id}`}]},{id:"b",parentId:"a",role:"assistant",createdAt:2,parts:[{type:"text",text:"branch retained"}]}],queued:queued?[{}]:[]})},
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
