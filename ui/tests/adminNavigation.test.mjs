import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require=createRequire(import.meta.url);
function layout(user, canAccessResearch=false) {
  const code=ts.transpileModule(readFileSync(new URL("../src/product/AdminLayout.tsx",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={}; const mocks={
    "@tanstack/react-router": { Link:({to,children,...props})=>React.createElement("a",{href:to,...props},children),Outlet:()=>React.createElement("div",null,"protected-management-content"),useRouterState:({select})=>select({location:{pathname:"/mobilesci/admin/cases"}}) },
    "./AuthSession":{useAuthSession:()=>({user,canAccessResearch,logout:async()=>{}})},
    "../appBasePath":{stripAppBase:(path)=>path.replace(/^\/mobilesci/,"")},
  };
  new Function("require","exports",code)((id)=>id in mocks?mocks[id]:require(id),exports);
  return renderToStaticMarkup(React.createElement(exports.AdminLayout));
}
test("only administrators can mount management content",()=>{
  for(const user of [null,{id:"reader",isAdmin:false}]){
    const html=layout(user);assert.match(html,/无权访问系统管理/);assert(!html.includes("protected-management-content"));assert(!html.includes("用户管理"));
  }
});
test("administrators share user and case navigation independently of research access",()=>{
  const html=layout({id:"admin",name:"管理员",email:"admin@test.invalid",isAdmin:true});
  assert.match(html,/href="\/admin\/users"/);assert.match(html,/href="\/admin\/cases" aria-current="page"/);
  assert.match(html,/protected-management-content/);assert.match(html,/查看公共案例/);assert(!html.includes("返回科研工作台"));
  assert.match(layout({id:"admin",isAdmin:true},true),/返回科研工作台/);
});
