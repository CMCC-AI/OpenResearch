import test from "node:test";
import assert from "node:assert/strict";
import { snapshotMessages } from "../src/product/caseSnapshot.ts";

test("snapshot includes every saved message, tool output, reasoning and nested agent records",()=>{
  const parts=[{id:"t",type:"tool",tool:"exec",state:{status:"completed",input:{command:"python experiment.py"},output:"complete results"},children:[{id:"nested",type:"text",text:"nested transcript"}]},{id:"r",type:"reasoning",text:"saved reasoning"},{id:"p",type:"prompt",prompt:{kind:"permission",approved:true}}];
  const input=[{id:"private-1",role:"user",createdAt:1,parts:[{id:"a",type:"text",text:"original question"}]},{id:"private-2",parentId:"private-1",role:"assistant",createdAt:2,parts},{id:"private-branch",parentId:"private-1",role:"assistant",createdAt:3,parts:[{id:"h",type:"text",text:"<script>plain text</script>"}]}];
  const result=snapshotMessages(input);
  assert.equal(result.length,3);assert.equal(result[1].parentId,"message-1");assert.equal(result[2].parentId,"message-1");
  for(const part of parts)assert.ok(result[1].content.includes(JSON.stringify(part,null,2)));
  assert.equal(result[2].content,"<script>plain text</script>");assert.equal(result[0].id,"message-1");
  assert.equal(input[0].id,"private-1");
});
