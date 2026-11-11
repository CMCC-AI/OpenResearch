import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as markdownTarget from "../src/markdownTarget.ts";
import * as markdownNormalization from "../src/markdownNormalization.ts";
import * as remarkFigures from "../src/remarkFigures.ts";

const require=createRequire(import.meta.url);
function load(path,stubs) {
  const source=readFileSync(new URL(path,import.meta.url),"utf8");
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};new Function("require","exports",code)((name)=>name in stubs?stubs[name]:/\.(svg|png)$/.test(name)?{default:name}:require(name),exports);return exports;
}
let mountedWorkspace = null;
let carouselType;
const markdown = load("../src/components/Md.tsx", {
  "@clo/react-markdown": {Markdown:({components})=>{carouselType=components["image-carousel"];return null;}},
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
test("Markdown updates retain the carousel component type and therefore its selected figure",()=>{
  renderToStaticMarkup(React.createElement(markdown.Md,{text:"![a](a.png)\n\n![b](b.png)", resolveImageSrc:()=>[]}));
  const first=carouselType;
  assert.equal(typeof first,"function");
  renderToStaticMarkup(React.createElement(markdown.Md,{text:"![a](a.png)\n\n![b](b.png)\nupdated", resolveImageSrc:()=>[]}));
  assert.equal(carouselType,first,"React must preserve the stateful carousel across streamed text and fresh resolver callbacks");
});
