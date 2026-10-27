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
  assert.match(html,/href="\/admin\/opencode"/);
  assert.match(html,/protected-management-content/);assert.match(html,/查看公共案例/);assert(!html.includes("返回科研工作台"));
  assert.match(layout({id:"admin",isAdmin:true},true),/返回科研工作台/);
});

function researchSidebar(user, canAccessResearch = true) {
  const code = ts.transpileModule(readFileSync(new URL("../src/product/ProductNav.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  const mocks = {
    "@tanstack/react-router": { Link: ({ to, children, ...props }) => React.createElement("a", { href: to, ...props }, children), useRouterState: ({ select }) => select({ location: { pathname: "/mobilesci/projects" } }) },
    "./AuthSession": { useAuthSession: () => ({ user, canAccessResearch }) },
    "../appBasePath": { stripAppBase: (path) => path.replace(/^\/mobilesci/, "") },
    "../components/Wordmark": { BrandMark: () => null },
    "../components/ui": { IconButton: () => null },
    "../components/ResearchNavigation": { ResearchProjectNavigation: () => null },
    "../components/AccountMenu": { AccountMenu: () => null },
  };
  new Function("require", "exports", code)((id) => id in mocks ? mocks[id] : /\.(svg|png)$/.test(id) ? { default: id } : require(id), exports);
  return renderToStaticMarkup(React.createElement(exports.ProductSidebar));
}

test("research sidebar keeps administration inside the account menu", () => {
  for (const access of [true, false]) {
    for (const user of [null, { id: "reader", isAdmin: false }, { id: "admin", isAdmin: true }]) {
      const html = researchSidebar(user, access);
      assert.ok(!html.includes('/admin/users'));
      assert.ok(!html.includes('系统管理'));
    }
  }
});


test("product navigation uses the consolidated new conversation entry", () => {
  const html = researchSidebar({ id: "researcher" });
  assert.equal((html.match(/aria-label="新对话"/g) ?? []).length, 1);
  assert.ok(!html.includes('aria-label="新建项目"'));
});
