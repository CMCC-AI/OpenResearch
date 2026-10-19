import test from "node:test";
import assert from "node:assert/strict";
import { canonicalRequest, createReadOnlyProjectApi, installReadOnlyApi, projectRequest, projectAssetUrl, getReadOnlyApi } from "../src/readOnlyApi.ts";

const snapshot=()=>({version:1,projectId:"original-project",sessionId:"original-session",responses:{
  "/api/projects":{projects:[{id:"original-project",name:"原项目",repoPath:"/original/path"}]},
  "/api/chat/sessions/original-session/messages":{messages:[{id:"original-message",role:"assistant",createdAt:1,completedAt:10,parts:[{id:"tool",type:"tool",tool:"bash",state:{status:"completed",input:{command:"python analysis.py"},output:"original output"}}]},{id:"branch",role:"assistant",parts:[]}],activeLeafId:"original-message",queued:[]},
  "/api/settings/ui-state":{workspace:null,onboardingCompleted:true,preferredAgent:null},
},assets:{"/api/projects/original-project/file/raw?path=report.md&sessionId=original-session":"native-abc.md"}});

test("the real project API receives the original structured records without flattening or rewriting",async()=>{
 const workspace=snapshot(),api=createReadOnlyProjectApi({id:"case-1",base:"http://localhost:5300",admin:false,workspace});
 const cleanup=installReadOnlyApi(api);const originalFetch=globalThis.fetch;let liveReads=0;
 globalThis.fetch=async()=>{liveReads++;throw new Error("No live project request allowed");};
 try {
   const data=await (await projectRequest("/api/chat/sessions/original-session/messages")).json();
   assert.deepEqual(data,workspace.responses["/api/chat/sessions/original-session/messages"]);
   assert.equal((await projectRequest("/api/projects/other-project/file?path=private")).status,404);
   for(const [url,method]of [["/api/chat/sessions/original-session/message","POST"],["/api/projects/original-project/file","PUT"],["/api/projects/original-project","DELETE"],["/api/research/studies/study/stop","POST"]])assert.equal((await projectRequest(url,{method,body:"{}"})).status,403);
   assert.equal(liveReads,0);
   assert.equal(projectAssetUrl("/api/projects/original-project/file/raw?sessionId=original-session&path=report.md"),"http://localhost:5300/api/platform/cases/case-1/assets?name=native-abc.md");
   assert.ok(projectAssetUrl("/api/files/abs/raw?path=/private/key").endsWith("name=missing"));
 }finally{globalThis.fetch=originalFetch;cleanup();}
 assert.equal(getReadOnlyApi(),null);
});

test("branch browsing and panel layout only update the reader's in-memory copy",async()=>{
 const workspace=snapshot(),api=createReadOnlyProjectApi({id:"case",base:"",admin:false,workspace});
 assert.equal((await api.read("/api/chat/sessions/original-session/branch",{method:"POST",body:JSON.stringify({leafId:"branch"})})).status,200);
 assert.equal((await(await api.read("/api/chat/sessions/original-session/messages")).json()).activeLeafId,"branch");
 assert.equal(workspace.responses["/api/chat/sessions/original-session/messages"].activeLeafId,"original-message");
 await api.read("/api/settings/ui-state",{method:"POST",body:JSON.stringify({workspace:{panelWidth:600}})});
 const state=await(await api.read("/api/settings/ui-state")).json();assert.equal(state.onboardingCompleted,true);assert.equal(state.workspace.panelWidth,600);assert.equal(workspace.responses["/api/settings/ui-state"].workspace,null);
 assert.equal(canonicalRequest("/api/file?z=2&a=1"),"/api/file?a=1&z=2");
});
