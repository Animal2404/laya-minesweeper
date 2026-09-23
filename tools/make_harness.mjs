/* 从 static/index.html 抽出求解器代码，生成 tests/_harness.cjs，
 * 供 Node 侧回归测试与批量跑局使用。
 * 用法：node tools/make_harness.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('找不到 <script>'); process.exit(2); }
let js = m[1];
js = js.replace(/const MODEL = [^;]+;/, "const MODEL='x';");
js = js.replace(/async function askLaya[\s\S]*?\n\}\n/, "async function askLaya(){ throw new Error('no net'); }\n");

const stub = `'use strict';
global.location={search:''};
const _e=()=>({style:{setProperty(){}},classList:{add(){},remove(){},toggle(){},contains(){return false}},
 children:[],dataset:{},textContent:'',value:'2',innerHTML:'',className:'',appendChild(){},
 addEventListener(){},querySelector(){return null},querySelectorAll(){return[]},getAttribute(){return null},
 setAttribute(){},removeAttribute(){},closest(){return null},getBoundingClientRect(){return{width:1000}},
 clientWidth:1000,scrollWidth:1000,options:[{textContent:'2',value:'2'}],selectedIndex:0});
global.document={documentElement:_e(),body:_e(),title:'',getElementById(){return _e()},
 querySelector(){return _e()},querySelectorAll(){return[]},createElement(){return _e()},
 createTextNode(d){return{data:d}},addEventListener(){}};
global.window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})};
global.localStorage={getItem(){return null},setItem(){}};global.performance={now:()=>Date.now()};
global.MutationObserver=class{observe(){}};global.HTMLElement={prototype:{}};
global.setInterval=()=>0;global.clearInterval=()=>{};global.setTimeout=()=>0;
`;

// 把内部函数暴露给外界
const exports = `
module.exports = {Board, solve, planMoves, applyMove, cloneBoard, buildConstraints,
  isGuessFreeBoard, twoStepLoss, sampleWorlds, forecast, buildCandidates, decideMove, gp0,
  setSize(c,r,m){COLS=c;ROWS=r;MINES=m;},
  getSize(){return {COLS,ROWS,MINES};}};
`;

const out = stub + js + exports;
fs.mkdirSync(path.join(ROOT, 'tests'), {recursive: true});
fs.writeFileSync(path.join(ROOT, 'tests', '_harness.cjs'), out);
console.log('生成 tests/_harness.cjs  ' + out.length + ' 字节');
