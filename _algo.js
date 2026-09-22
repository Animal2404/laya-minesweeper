'use strict';
const _els={};
function _mkEl(){const e={style:{setProperty(){}},classList:{add(){},remove(){},toggle(){},contains(){return false}},
 children:[],dataset:{},textContent:'',value:'2',innerHTML:'',className:'',
 appendChild(c){this.children.push(c)},addEventListener(){},querySelector(){return null},querySelectorAll(){return []},
 getAttribute(){return null},setAttribute(){},removeAttribute(){},closest(){return null},
 getBoundingClientRect(){return{width:1000}},clientWidth:1000,scrollWidth:1000,options:[{textContent:'2',value:'2'}],selectedIndex:0};return e}
global.document={documentElement:_mkEl(),body:_mkEl(),title:'',
 getElementById(id){if(!_els[id])_els[id]=_mkEl();return _els[id]},
 querySelector(){return _mkEl()},querySelectorAll(){return []},createElement(){return _mkEl()},
 createTextNode(d){return{data:d}},addEventListener(){}};
global.window={addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}})};
global.localStorage={getItem(){return null},setItem(){}};
global.performance={now:()=>Date.now()};
global.MutationObserver=class{observe(){}disconnect(){}};
global.HTMLElement={prototype:{}};
global.setInterval=()=>0;global.clearInterval=()=>{};global.setTimeout=()=>0;

'use strict';

/* ==========================================================================
 * 配置
 * ======================================================================== */
/* 棋盘尺寸与雷数改为可变 —— 支持自定义与难度预设。
 * 用 let 而非 const：所有既有引用点无需改动，改棋盘只需重新赋值。 */
let COLS = 30, ROWS = 16, MINES = 99;

/* 难度预设。密度 = 雷数 / 总格数，是决定"难不难"的核心指标。
 *   经典 Windows 扫雷：初级 10/81=12.3%，中级 16/256=15.6%，高级 99/480=20.6%
 *   本项目默认 99/480 = 20.6%（等同经典高级）
 * 越往上密度越高，需要猜的次数越多 —— 因为逻辑可解的格子会变少。 */
const LEVELS = [
  {id:'beginner', name:'初级',     cols:9,  rows:9,  mines:10},
  {id:'easy',     name:'简单',     cols:16, rows:12, mines:26},
  {id:'medium',   name:'中级',     cols:20, rows:14, mines:50},
  {id:'default',  name:'经典·默认', cols:30, rows:16, mines:99},
  {id:'hard',     name:'困难',     cols:30, rows:16, mines:140},
  {id:'expert',   name:'专家',     cols:40, rows:20, mines:260},
  {id:'insane',   name:'地狱',     cols:50, rows:24, mines:520},
  {id:'custom',   name:'自定义 …',  cols:30, rows:16, mines:99},
];
const LEVEL_BY_ID = Object.fromEntries(LEVELS.map(l => [l.id, l]));

/* 显示格子的总数量 —— 需求要求"每个都要显示格子总数"，故三处都显示：
 * 状态栏、难度下拉、自定义面板。 */
function density() { return MINES / (COLS * ROWS); }
function levelLabel() {
  const lv = LEVELS.find(l => l.cols === COLS && l.rows === ROWS && l.mines === MINES);
  const pct = (density() * 100).toFixed(1);
  return (lv && lv.id !== 'custom' ? lv.name : '自定义') + ` · ${COLS}×${ROWS}=${COLS*ROWS} 格 · ${MINES} 雷 · ${pct}%`;
}
/* 每格边长随棋盘缩放。
 * 不用固定宽度猜，而是取容器**实际**可用宽度 —— 否则 50 列以上必然横向溢出。
 * 减去 2px 间隙/格与容器内边距，再夹在可读范围内。 */
function cellSize() {
  const wrap = el('board') && el('board').closest('.boardwrap');
  const avail = (wrap ? wrap.clientWidth : 1138) - 34;   // 34 ≈ padding + 间隙总和
  const gap = 2;
  let cs = Math.floor((avail - (COLS - 1) * gap) / COLS);
  return Math.max(10, Math.min(26, cs));
}
const API = '/api/predict';
/* 必须显式指定模型，不能交给 Router 自动路由：
 * boards 的 state 是中文，Router 会判定「非拉丁文字 → multilingual」，
 * 而本机只保留了 typed-decisions，multilingual 已被删除，
 * 于是会抛 FileNotFoundError: Subfolder 'multilingual' not found（HTTP 500）。
 * 需要别的模型时用 ?model=xxx 覆盖。 */
const MODEL='x';

/* ==========================================================================
 * 棋盘
 * ======================================================================== */
const NB = [];
for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
  if (dr || dc) NB.push([dr, dc]);

class Board {
  constructor() { this.reset(); }
  reset() {
    this.cells = Array.from({length: ROWS}, () => Array.from({length: COLS},
      () => ({mine: false, op: false, flag: false, adj: 0})));
    this.started = false; this.over = false; this.win = false;
    this.revealed = 0; this.flags = 0; this.steps = 0;
    this.t0 = 0; this.elapsed = 0;
  }
  inside(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
  nb(r, c) {
    const out = [];
    for (const [dr, dc] of NB) if (this.inside(r+dr, c+dc)) out.push([r+dr, c+dc]);
    return out;
  }
  /** 首次点击后再布雷。
   *  保证：首点本身 + 周围 8 格都无雷 —— 也就是首点的 adj 一定为 0，
   *  从而触发洪水填充、一次开出大片空白。
   *  这一条很关键：若只保证"首点无雷"，周围有雷时 adj≠0 就不会展开，
   *  开局后一个约束都没有，求解器只能盲猜（实测首步就 17% 概率踩雷）。 */
  plant(sr, sc) {
    const safe = new Set([sr + ',' + sc]);
    for (const [r, c] of this.nb(sr, sc)) safe.add(r + ',' + c);
    const pool = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
      if (!safe.has(r + ',' + c)) pool.push([r, c]);
    // Fisher-Yates，取前 MINES 个
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let i = 0; i < MINES && i < pool.length; i++) {
      const [r, c] = pool[i];
      this.cells[r][c].mine = true;
    }
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      let n = 0;
      for (const [rr, cc] of this.nb(r, c)) if (this.cells[rr][cc].mine) n++;
      this.cells[r][c].adj = n;
    }
    this.started = true; this.t0 = Date.now();
  }
  reveal(r, c) {
    const cell = this.cells[r][c];
    if (this.over || cell.op || cell.flag) return false;
    if (!this.started) this.plant(r, c);
    if (cell.mine) {
      this.over = true; this.win = false; cell.op = true; this.boom = [r, c];
      // 冻结用时（与 checkWin 一致）：否则 elapsedMs() 返回初始值 0，显示 0:00
      this.elapsed = this.started ? Date.now() - this.t0 : 0;
      return false;
    }
    // 洪水填充
    const stack = [[r, c]];
    while (stack.length) {
      const [rr, cc] = stack.pop();
      const x = this.cells[rr][cc];
      if (x.op || x.flag) continue;
      x.op = true; this.revealed++;
      if (x.adj === 0) for (const [r2, c2] of this.nb(rr, cc))
        if (!this.cells[r2][c2].op && !this.cells[r2][c2].flag) stack.push([r2, c2]);
    }
    this.checkWin();
    return true;
  }
  toggleFlag(r, c) {
    const x = this.cells[r][c];
    if (this.over || x.op) return;
    x.flag = !x.flag;
    this.flags += x.flag ? 1 : -1;
    this.checkWin();
  }
  /** 双击已揭开的数字：周围旗数够了就展开其余邻格（和弦） */
  chord(r, c) {
    const x = this.cells[r][c];
    if (this.over || !x.op || x.adj === 0) return false;
    let f = 0;
    const hid = [];
    for (const [rr, cc] of this.nb(r, c)) {
      const y = this.cells[rr][cc];
      if (y.flag) f++;
      else if (!y.op) hid.push([rr, cc]);
    }
    if (f !== x.adj || !hid.length) return false;
    let ok = true;
    for (const [rr, cc] of hid) if (!this.reveal(rr, cc)) ok = false;
    return ok;
  }
  checkWin() {
    if (this.over) return;
    if (this.revealed >= ROWS * COLS - MINES) {
      this.over = true; this.win = true;
      // 冻结用时：否则 elapsedMs() 在 over 后仍会返回 elapsed（初始 0），显示 0:00
      this.elapsed = this.started ? Date.now() - this.t0 : 0;
    }
  }
  safeLeft() { return (ROWS * COLS - MINES) - this.revealed; }
  elapsedMs() { return this.started ? (this.over ? this.elapsed : Date.now() - this.t0) : 0; }
}

/* ==========================================================================
 * 约束求解器
 *
 * 每个已揭开的数字 = 一条约束 {cells: 未揭开的邻格, mines: 还需几颗雷}
 *   规则 1/2  单格推导：mines==0 → 全安全；mines==cells.length → 全是雷
 *   规则 3    子集推导：若 A.cells ⊂ B.cells，则 B\A 需 (B.mines - A.mines) 颗
 *   规则 4    完全枚举：对每个连通块穷举所有合法布雷方案 → 得到**精确**概率
 * ======================================================================== */
function buildConstraints(b) {
  const cons = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = b.cells[r][c];
    if (!x.op || x.adj === 0) continue;
    const cells = [];
    let f = 0;
    for (const [rr, cc] of b.nb(r, c)) {
      const y = b.cells[rr][cc];
      if (y.flag) f++;
      else if (!y.op) cells.push(rr + ',' + cc);
    }
    const need = x.adj - f;
    if (need < 0) return {error: '旗子插多了'};
    if (cells.length) cons.push({cells, mines: need, from: [r, c]});
  }
  return {cons};
}

function key2rc(k) { const [r, c] = k.split(',').map(Number); return [r, c]; }

/** 连通块：共享格子的约束归为一组（枚举要按块做，否则组合爆炸） */
function components(cons) {
  const groups = [];
  const used = new Array(cons.length).fill(false);
  for (let i = 0; i < cons.length; i++) {
    if (used[i]) continue;
    const q = [i]; used[i] = true;
    const idx = [], cellset = new Set();
    while (q.length) {
      const k = q.pop(); idx.push(k);
      for (const cell of cons[k].cells) cellset.add(cell);
      for (let j = 0; j < cons.length; j++) {
        if (used[j]) continue;
        if (cons[j].cells.some(x => cellset.has(x))) { used[j] = true; q.push(j); }
      }
    }
    groups.push({idx, cells: [...cellset]});
  }
  return groups;
}

/** 完全枚举一个连通块 → 每格精确含雷概率 */
function enumerateGroup(cons, idx, cells, cap, nodeBudget, deadline) {
  const n = cells.length;
  if (!n) return {probs: null, solutions: 0, hist: null, perCell: null};
  if (n > cap) return {probs: null, solutions: 0, hist: null, perCell: null};

  const pos = new Map(cells.map((k, i) => [k, i]));

  // 只有约束的**全部**格子都在本块内时才可用。
  // 若过滤掉块外的格子，need 不变而候选格变少 —— 约束被削弱，
  // 会把"不确定"误判成"必然是雷"（实测在专家难度上会错格子）。
  const sub = [];
  for (const i of idx) {
    const bits = [];
    let complete = true;
    for (const k of cons[i].cells) {
      const v = pos.get(k);
      if (v === undefined) { complete = false; break; }
      bits.push(v);
    }
    if (complete && bits.length) sub.push({bits, need: cons[i].mines});
  }
  if (!sub.length) return {probs: null, solutions: 0, hist: null, perCell: null};

  // 每个格子被哪些约束涉及 —— 用于增量剪枝
  const watch = Array.from({length: n}, () => []);
  sub.forEach((sv, si) => { for (const b of sv.bits) watch[b].push(si); });

  const assign = new Int8Array(n).fill(-1);
  const siMines = new Int32Array(sub.length);
  const siUnset = new Int32Array(sub.length);
  sub.forEach((sv, si) => { siUnset[si] = sv.bits.length; });

  const hist = new Map();                       // 本块总雷数 -> 方案数
  const countByM = cells.map(() => new Map());  // 每格：总雷数 -> 是雷的方案数
  let solutions = 0, nodes = 0, blown = false;
  const budget = nodeBudget || 3e5;
  // 每 8192 个节点查一次时间。只在块与块之间查是不够的 ——
  // 单个大块就能跑掉好几秒，游戏会直接卡死。
  const CHECK_EVERY = 8192;

  function feasible(si) {
    const sv = sub[si], left = siUnset[si], got = siMines[si];
    return got <= sv.need && got + left >= sv.need;
  }

  function dfs(i, placed) {
    if (blown) return;
    if (++nodes > budget) { blown = true; return; }
    if ((nodes % CHECK_EVERY) === 0 && deadline && performance.now() > deadline) {
      blown = true; return;
    }
    if (i === n) {
      for (let si = 0; si < sub.length; si++) if (siMines[si] !== sub[si].need) return;
      solutions++;
      hist.set(placed, (hist.get(placed) || 0) + 1);
      for (let k = 0; k < n; k++) {
        if (assign[k] === 1) {
          const mp = countByM[k];
          mp.set(placed, (mp.get(placed) || 0) + 1);
        }
      }
      return;
    }
    for (const val of [0, 1]) {
      assign[i] = val;
      let ok = true;
      for (const si of watch[i]) {
        if (val === 1) siMines[si]++;
        siUnset[si]--;
        if (!feasible(si)) ok = false;
      }
      if (ok) dfs(i + 1, placed + val);
      for (const si of watch[i]) {
        if (val === 1) siMines[si]--;
        siUnset[si]++;
      }
      assign[i] = -1;
      if (blown) return;
    }
  }
  dfs(0, 0);

  if (blown || !solutions) return {probs: null, solutions: 0, hist: null, perCell: null};

  const probs = new Map();
  for (let k = 0; k < n; k++) {
    let hit = 0;
    for (const c of countByM[k].values()) hit += c;
    const val = solutions > 0 ? hit / solutions : NaN;
    if (Number.isFinite(val)) probs.set(cells[k], val);
  }
  const perCell = new Map();
  cells.forEach((k, i) => perCell.set(k, countByM[i]));
  return {probs, solutions, hist, perCell};
}

function solve(b, depth) {
  const built = buildConstraints(b);
  if (built.error) return {error: built.error};
  let cons = built.cons;

  const safe = new Set(), mines = new Set();
  const markSafe = k => { if (!safe.has(k)) { safe.add(k); return true; } return false; };
  const markMine = k => { if (!mines.has(k)) { mines.add(k); return true; } return false; };

  // ==========================================================================
  // 阶段一：局部约束传播
  //   规则 1/2  单格：need==0 → 全安全；need==len → 全是雷
  //   规则 3    子集：A ⊂ B 且 A 需 a 颗、B 需 b 颗 → B\A 需 b-a 颗
  // ==========================================================================
  function reduce() {
    return cons.map(k => {
      const cells = k.cells.filter(x => !safe.has(x) && !mines.has(x));
      const dec = k.cells.filter(x => mines.has(x)).length;
      return {cells, mines: k.mines - dec, from: k.from};
    }).filter(k => k.cells.length > 0);
  }

  for (let round = 0; round < Math.max(1, depth); round++) {
    let changed = false;
    cons = reduce();

    for (const k of cons) {
      if (k.mines === 0) { for (const x of k.cells) if (markSafe(x)) changed = true; }
      else if (k.mines === k.cells.length) { for (const x of k.cells) if (markMine(x)) changed = true; }
    }
    if (changed) cons = reduce();

    // 子集推导（A⊂B 与 B⊂A 都查）
    for (let i = 0; i < cons.length; i++) {
      const A = cons[i];
      if (!A.cells.length) continue;
      const sa = new Set(A.cells);
      for (let j = 0; j < cons.length; j++) {
        if (i === j) continue;
        const B = cons[j];
        let small = A, big = B;
        if (B.cells.length < A.cells.length) { small = B; big = A; }
        if (small.cells.length === big.cells.length) continue;
        const setBig = (big === A) ? sa : new Set(B.cells);
        if (!small.cells.every(x => setBig.has(x))) continue;
        const setSmall = new Set(small.cells);
        const rest = big.cells.filter(x => !setSmall.has(x));
        const need = big.mines - small.mines;
        if (need < 0 || need > rest.length) continue;
        if (need === 0) { for (const x of rest) if (markSafe(x)) changed = true; }
        else if (need === rest.length) { for (const x of rest) if (markMine(x)) changed = true; }
      }
    }
    if (!changed) break;
  }

  cons = reduce();

  // ==========================================================================
  // 阶段二：按连通块做 DFS 剪枝完全枚举
  //
  // 关键点：
  //   1. 约束必须**完整**落在块内才参与枚举（见 enumerateGroup 内注释）。
  //   2. cap 只是防退化的第一道闸；真正的保护是节点预算 + deadline。
  //   3. 只有「全部块都精确枚举成功」时才做全局 DP。若某块走了 splitGroup
  //      降级，子块之间会互相重叠、独立性被破坏，DP 前提不成立 ——
  //      强行使用会算出错误概率（实测在地狱难度上把安全格判成"必然是雷"）。
  // ==========================================================================
  const probs = new Map();
  const groups = components(cons);
  const CAP = 64;
  const budgetFor = n => Math.min(4e5, Math.max(3e4, n * n * 400));
  // 全局时间闸：deadline 会传进 DFS 内部，因此单个大块也无法超时
  const SOLVE_BUDGET_MS = 700;
  const deadline = performance.now() + SOLVE_BUDGET_MS;

  let enumCells = 0, solutions = 0, tooBig = 0, exactAll = true;
  const solved = [];
  const localProbs = new Map();

  for (const g of groups) {
    if (performance.now() > deadline) { exactAll = false; tooBig++; continue; }
    const r = enumerateGroup(cons, g.idx, g.cells, CAP, budgetFor(g.cells.length), deadline);
    if (!r.probs) {
      tooBig++;
      exactAll = false;                     // 降级 → 放弃全局 DP
      // 拆子块，能精确多少算多少（只进局部概率，不参与全局加权）
      for (const sub of splitGroup(cons, g, 22)) {
        if (performance.now() > deadline + 300) break;
        const rr = enumerateGroup(cons, sub.idx, sub.cells, 22, budgetFor(sub.cells.length), deadline + 300);
        if (rr.probs) {
          for (const [k, p] of rr.probs) localProbs.set(k, p);
          enumCells += sub.cells.length; solutions += rr.solutions;
        }
      }
      continue;
    }
    for (const [k, p] of r.probs) localProbs.set(k, p);
    enumCells += g.cells.length; solutions += r.solutions;
    solved.push({hist: r.hist, perCell: r.perCell, cells: g.cells});
  }
  for (const [k, p] of localProbs) probs.set(k, p);

  // ==========================================================================
  // 阶段三：全局雷数约束（仅在块之间真正独立时启用）
  //
  // 用 DP 统计「所有块 + 自由格的总雷数 == 剩余雷数」的组合，
  // 再据此重算每格边际概率。这是原先完全没用上的信息，
  // 也是"少猜"的关键来源。
  // ==========================================================================
  const totalHidden = countHidden(b);
  const minesLeft = MINES - b.flags;
  let globalWeight = 0;

  if (exactAll && solved.length) {
    const gi = combineGlobally(solved, totalHidden, minesLeft);
    if (gi) {
      globalWeight = gi.weight;
      for (const [k, p] of gi.probs) probs.set(k, p);   // 全局约束更强，覆盖局部
      // 把全局证明出的"必然"提升为确定结论，否则会白白去猜
      for (const k of gi.certainSafe) markSafe(k);
      for (const k of gi.certainMine) markMine(k);

      // 未被任何约束覆盖的自由格：用全局 DP 推出的概率填上。
      // 不做这一步，高密度盘面上绝大多数格子就没有精确概率，
      // 猜测只能退回粗略的密度估计（实测地狱难度覆盖率仅 1.3%）。
      if (Number.isFinite(gi.freeP)) {
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
          const x = b.cells[r][c];
          if (x.op || x.flag) continue;
          const k = r + ',' + c;
          if (!probs.has(k)) probs.set(k, gi.freeP);
        }
      }
    }
  }

  for (const k of safe) probs.set(k, 0);
  for (const k of mines) probs.set(k, 1);

  // 最后兜底清洗：任何非有限概率都删掉，让调用方走密度估计。
  // 不做这一步会在界面上显示 "P(雷) NaN%"。
  for (const [k, v] of [...probs]) if (!Number.isFinite(v)) probs.delete(k);

  return {safe, mines, probs, cons, groups, enumCells, solutions, tooBig,
          exactAll, totalHidden, minesLeft, globalWeight};
}

/** 未揭开且未插旗的格数 */
function countHidden(b) {
  let n = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = b.cells[r][c];
    if (!x.op && !x.flag) n++;
  }
  return n;
}

/**
 * 全局雷数约束：把各**独立**块的方案按「总雷数 == 剩余雷数」加权组合。
 *
 * solved: [{hist: Map(雷数→方案数), perCell: Map(格→Map(雷数→是雷方案数))}]
 * 返回 {probs, weight, certainSafe, certainMine}；数据不足时返回 null。
 */
function combineGlobally(solved, totalHidden, minesLeft) {
  if (minesLeft < 0 || !solved.length) return null;

  let touched = 0;
  for (const b of solved) touched += b.perCell.size;
  const freeCells = Math.max(0, totalHidden - touched);
  const maxM = minesLeft;
  const K = solved.length;

  // 前缀 / 后缀卷积：pre[b] = 前 b 块凑出 j 颗雷的方案数
  const conv = (cur, h) => {
    const nf = new Float64Array(maxM + 1);
    for (let j = 0; j <= maxM; j++) {
      if (!cur[j]) continue;
      for (const [m, c] of h) if (j + m <= maxM) nf[j + m] += cur[j] * c;
    }
    return nf;
  };
  const pre = [], suf = [];
  {
    let cur = new Float64Array(maxM + 1); cur[0] = 1;
    for (let b = 0; b < K; b++) { pre.push(cur); cur = conv(cur, solved[b].hist); }
  }
  {
    let cur = new Float64Array(maxM + 1); cur[0] = 1;
    for (let b = K - 1; b >= 0; b--) { suf.unshift(cur); cur = conv(cur, solved[b].hist); }
  }

  const probs = new Map();
  const certainSafe = new Set(), certainMine = new Set();
  let Z = 0;

  for (let b = 0; b < K; b++) {
    const bl = solved[b];

    // 其余块凑出 s 颗雷的权重
    const others = new Float64Array(maxM + 1);
    for (let j = 0; j <= maxM; j++) {
      if (!pre[b][j]) continue;
      for (let k2 = 0; j + k2 <= maxM; k2++) {
        const v = pre[b][j] * suf[b][k2];
        if (v) others[j + k2] += v;
      }
    }

    // 本块取 m 颗雷时，剩余 (minesLeft - s - m) 由自由格承担
    // wByM[m] = Σ_s others[s] * C(freeCells, minesLeft - s - m)
    const wByM = new Float64Array(maxM + 1);
    for (let m = 0; m <= maxM; m++) {
      let w = 0;
      for (let s2 = 0; s2 + m <= maxM; s2++) {
        if (!others[s2]) continue;
        const needFree = minesLeft - s2 - m;
        if (needFree < 0 || needFree > freeCells) continue;
        w += others[s2] * binom(freeCells, needFree);
      }
      wByM[m] = w;
    }

    // 分母必须是 Σ_m hist[m] * wByM[m]。
    // 早先写成 histSum * Σ_m wByM[m] 是错的：wByM 随 m 变化时会把概率
    // 错算成 1，实测在地狱难度上把安全格判成"必然是雷"。
    let denom = 0;
    for (const [m, c] of bl.hist) denom += c * wByM[m];
    if (!(denom > 0)) continue;
    Z += denom;

    for (const [cell, perM] of bl.perCell) {
      let num = 0;
      for (const [m, c] of perM) num += c * wByM[m];
      const val = num / denom;
      // denom 为 0 或数值退化时会得到 NaN；直接丢弃这一格的概率，
      // 由调用方回退到全局密度估计（否则界面会显示 "P(雷) NaN%"）。
      if (Number.isFinite(val)) probs.set(cell, Math.max(0, Math.min(1, val)));

      // 用**精确整数条件**判定"必然"，不做浮点相等比较：
      //   wByM[m] 为 0 表示本块取 m 颗雷时剩余雷数凑不出来，该 m 全局不可行
      let neverMine = true, alwaysMine = true;
      for (const [m, c] of bl.hist) {
        if (!(wByM[m] > 0)) continue;
        const hit = perM.get(m) || 0;
        if (hit > 0) neverMine = false;
        if (hit < c) alwaysMine = false;
        if (!neverMine && !alwaysMine) break;
      }
      if (neverMine) certainSafe.add(cell);
      else if (alwaysMine) certainMine.add(cell);
    }
  }

  // ==========================================================================
  // 自由格概率 —— 这是原先缺失、却对"高密度盘面"最关键的一步。
  //
  // freeCells 是"未被任何约束覆盖"的格子。旧实现只把它用于 DP 归一化，
  // 从不给它赋概率，于是这些格子在 UI 上拿不到精确值、只能退回密度估计。
  // 实测地狱难度枚举覆盖率仅 1.3%，猜测几乎全靠估计 —— 这是通过率上不去的主因。
  //
  // 正确做法：自由格的含雷概率同样由全局 DP 决定。
  //   P(某自由格是雷) = E[自由格分配的雷数] / freeCells
  // 其中每个组合的权重是「其余块取 s 颗雷」×「从 freeCells 里选 (minesLeft-s) 个」。
  // ==========================================================================
  let freeP = null;
  if (freeCells > 0) {
    // 全部块合起来的分布
    let allDist = new Float64Array(maxM + 1); allDist[0] = 1;
    for (const bl of solved) allDist = conv(allDist, bl.hist);

    // 在对数域加权：C(1191,520) 直接算会溢出成 Infinity，
    // 再乘 0 得到 NaN —— 这正是自由格概率长期算不出来的原因。
    // 用 log 域做 logsumexp，最后再取比值，数值稳定。
    const terms = [];
    let maxLog = -Infinity;
    for (let j = 0; j <= maxM; j++) {
      if (!allDist[j]) continue;
      const needFree = minesLeft - j;
      if (needFree < 0 || needFree > freeCells) continue;
      const lg = Math.log(allDist[j]) + logBinomSafe(freeCells, needFree);
      if (!Number.isFinite(lg)) continue;
      terms.push({lg, needFree});
      if (lg > maxLog) maxLog = lg;
    }
    if (terms.length && Number.isFinite(maxLog)) {
      let wsum = 0, wmine = 0;
      for (const t of terms) {
        const w = Math.exp(t.lg - maxLog);      // 归一化后不会溢出
        wsum += w; wmine += w * t.needFree;
      }
      if (wsum > 0) freeP = wmine / (wsum * freeCells);
    }
  }

  return probs.size || freeP !== null
    ? {probs, weight: Z, certainSafe, certainMine, freeCells, freeP}
    : null;
}

/** 二项式系数 C(n,k)。
 *  用乘法而非阶乘，但 C(1191,520) 仍会溢出成 Infinity —— 而 Infinity 参与
 *  DP 加权会得到 NaN（Infinity * 0 = NaN），进而让自由格概率算不出来。
 *  实测这正是地狱难度"格子没有精确概率"的根因，与推理深度无关。 */
function binom(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  if (k === 0) return 1;
  // 超过这个规模就改用对数域，避免溢出
  if (n > 200) return Math.exp(logBinom(n, k));
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}

/** ln C(n,k)，用 lgamma 的 Lanczos 近似，n 很大也不溢出 */
function logBinom(n, k) {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}
function lgamma(x) {
  // Lanczos 近似，误差 ~1e-10，对本用途足够
  const g = 7;
  const C = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  x -= 1;
  let a = C[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += C[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln C(n,k)，供 DP 在对数域加权用 */
function logBinomSafe(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logBinom(n, k);
}

/** 把一个过大的连通块拆成若干小独立块（枚举不了时的降级路径） */
function splitGroup(cons, g, cap) {
  cap = cap || 26;
  const out = [];
  const used = new Set();
  for (const i of g.idx) {
    if (used.has(i)) continue;
    const idx = [], cells = new Set();
    const q = [i]; used.add(i);
    while (q.length) {
      const k = q.pop(); idx.push(k);
      for (const c of cons[k].cells) cells.add(c);
      const merged = new Set(cells);
      for (const j of g.idx) {
        if (used.has(j)) continue;
        if (!cons[j].cells.some(x => cells.has(x))) continue;
        for (const x of cons[j].cells) merged.add(x);
        if (merged.size > cap) break;
        used.add(j); q.push(j);
      }
      if (cells.size >= cap) break;
    }
    if (idx.length && cells.size) out.push({idx, cells: [...cells]});
  }
  return out;
}

/* ==========================================================================
 * 把待判格写成中文描述（给 Laya 看的）
 * ======================================================================== */
const DIRNAME = {'-1,-1':'西北','-1,0':'北','-1,1':'东北','0,-1':'西','0,1':'东',
                 '1,-1':'西南','1,0':'南','1,1':'东南'};

/** 描述某一格周边的约束事实 —— 只陈述事实，不给结论 */
function describeCell(b, r, c) {
  const parts = [];
  for (const [rr, cc] of b.nb(r, c)) {
    const x = b.cells[rr][cc];
    if (!x.op || x.adj === 0) continue;
    let f = 0, hidden = 0;
    for (const [r2, c2] of b.nb(rr, cc)) {
      const y = b.cells[r2][c2];
      if (y.flag) f++;
      else if (!y.op) hidden++;
    }
    if (hidden === 0) continue;
    const need = x.adj - f;
    const d = DIRNAME[(rr - r) + ',' + (cc - c)] || '旁边';
    parts.push(`${d}面是一个已揭开的 ${x.adj}，它周围还有 ${hidden} 个没揭开的格子，其中还需要 ${need} 颗雷`);
  }
  if (!parts.length) return '它周围没有可用的已知数字。';
  return '这一格' + parts.join('；') + '。';
}

function candidates(b) {
  // 所有「和已揭开数字相邻」的未揭开格 —— 也就是唯一值得判断的那些格
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = b.cells[r][c];
    if (x.op || x.flag) continue;
    if (b.nb(r, c).some(([rr, cc]) => b.cells[rr][cc].op && b.cells[rr][cc].adj > 0)) out.push(r + ',' + c);
  }
  return out;
}

/* ==========================================================================
 * 调 Laya
 * ======================================================================== */
async function askLaya(){ throw new Error('no net'); }

/* ==========================================================================
 * 界面
 * ======================================================================== */
const board = new Board();
const el = id => document.getElementById(id);
let auto = false, busy = false, lastCmp = null;
let stats = {agree: 0, total: 0, layaTop: 0, layaTopOK: 0};
/* 耗时埋点：求解与推理分开记，便于判断瓶颈在哪 */
const perf = {solve: [], infer: []};
let lastSolveMs = null, lastInferMs = null;

function buildGrid() {
  const g = el('board');
  const cs = cellSize();
  // 每格尺寸与字号用 CSS 变量下发，大棋盘自动缩小以免溢出
  g.style.setProperty('--cw', cs + 'px');
  g.style.setProperty('--cf', Math.max(9, Math.round(cs * 0.55)) + 'px');
  g.style.gridTemplateColumns = `repeat(${COLS}, ${cs}px)`;
  g.innerHTML = '';
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const d = document.createElement('div');
    d.className = 'cell hid'; d.dataset.r = r; d.dataset.c = c;
    d.style.gridRow = r + 1; d.style.gridColumn = c + 1;
    g.appendChild(d);
  }
  // 每次改棋盘都同步自定义输入框
  if (el('cCols'))  el('cCols').value  = COLS;
  if (el('cRows'))  el('cRows').value  = ROWS;
  if (el('cMines')) el('cMines').value = MINES;
  syncLevelSelect();
  updateCustomHint();
}

/* 把当前棋盘回写到难度下拉；若不是预设则选「自定义」 */
function syncLevelSelect() {
  const sel = el('level');
  if (!sel) return;
  const match = LEVELS.find(l => l.id !== 'custom' && l.cols === COLS && l.rows === ROWS && l.mines === MINES);
  sel.value = match ? match.id : 'custom';
  // 自定义项的文案带上当前实际尺寸，方便一眼看到总格数
  const c = sel.querySelector('option[value="custom"]');
  if (c) c.textContent = `自定义 … （当前 ${COLS}×${ROWS}=${COLS*ROWS} 格，${MINES} 雷）`;
}

/* 自定义面板的实时校验：雷数不能 >= 总格数，否则无解 */
function updateCustomHint() {
  const hint = el('cHint');
  if (!hint || !el('cCols')) return;
  const c = +el('cCols').value, r = +el('cRows').value, m = +el('cMines').value;
  const total = c * r;
  if (!(c >= 5 && r >= 5)) { hint.textContent = '⚠ 列与行至少 5'; hint.className = 'hint bad'; return false; }
  if (c > 80 || r > 60)    { hint.textContent = '⚠ 列 ≤ 80，行 ≤ 60'; hint.className = 'hint bad'; return false; }
  if (!(m >= 1) || m >= total) {
    hint.textContent = `⚠ 雷数需在 1 ~ ${Math.max(1, total - 1)} 之间（总格数 ${total}）`;
    hint.className = 'hint bad'; return false;
  }
  const pct = (100 * m / total);
  const tag = pct < 12 ? '偏易' : pct < 18 ? '适中' : pct < 23 ? '偏难' : '极难，需大量猜测';
  hint.textContent = `总格数 ${total}（${c}×${r}）· 雷密度 ${pct.toFixed(1)}% · ${tag}`;
  hint.className = 'hint';
  return true;
}

/* 应用一套棋盘参数并重开 */
function applyBoard(cols, rows, mines) {
  COLS = cols; ROWS = rows; MINES = mines;
  stopAuto();
  board.reset(); lastCmp = null;
  stats = {agree: 0, total: 0, layaTop: 0, layaTopOK: 0};
  perf.solve.length = 0; perf.infer.length = 0;
  lastSolveMs = lastInferMs = null;
  solverFlags.clear(); clearPreview();
  buildGrid(); renderCmp(null); paint();
  setStatus(`新棋盘：${COLS}×${ROWS} = <b>${COLS*ROWS}</b> 格，${MINES} 颗雷（密度 ${(density()*100).toFixed(1)}%）。点「让 Laya 来玩」或自己点格子。`);
  syncLevelSelect();
}

function paint() {
  const b = board;
  // 预览序号只画"接下来要执行"的走法；对局结束或卡住时 preview 为空
  const stepNo = new Map();
  const nextKey = (preview.length && !b.over) ? preview[0].key : null;
  if (!b.over) preview.forEach((m, i) => { if (m.kind === 'reveal') stepNo.set(m.key, i + 1); });

  for (const d of el('board').children) {
    const r = +d.dataset.r, c = +d.dataset.c, x = b.cells[r][c];
    const k = r + ',' + c;
    let cls = 'cell';
    let content = '';
    if (x.op) {
      cls += ' op';
      if (x.mine) {
        cls += (b.boom && b.boom[0] === r && b.boom[1] === c) ? ' boom' : ' mine';
        content = '💣';
      } else if (x.adj > 0) {
        cls += ' n' + Math.min(x.adj, 6);
        content = String(x.adj);
      } else cls += ' blank';
    } else {
      cls += ' hid';
      if (x.flag) {
        content = '⚑';
        // 求解器插的旗用独立样式，和玩家手动旗区分
        cls += solverFlags.has(k) ? ' flag solverflag' : ' flag';
      }
    }
    // 预览序号：盖在整格上并居中，不改变格子尺寸，因此不会遮住数字或旗子
    if (stepNo.has(k)) cls += (k === nextKey) ? ' stepnext' : '';
    d.className = cls;
    d.textContent = content;
    if (stepNo.has(k)) {
      const sp = document.createElement('span');
      sp.className = 'stepno';
      sp.textContent = stepNo.get(k);
      d.appendChild(sp);
    }
  }
  el('sSize').textContent = COLS + '×' + ROWS + ' = ' + (COLS*ROWS);
  el('sLevel').textContent = (density()*100).toFixed(1) + '%';
  el('sSafe').textContent = Math.max(0, b.safeLeft());
  el('sMines').textContent = MINES;
  el('sSteps').textContent = b.steps;
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const f1 = v => v == null ? '—' : (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ms';
  el('sSolve').textContent = f1(lastSolveMs) + ' / ' + f1(avg(perf.solve));
  el('sInfer').textContent = f1(lastInferMs) + ' / ' + f1(p50(perf.infer));
  el('sTime').textContent = fmt(b.elapsedMs());
}

function p50(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function setStatus(html, spin) {
  el('status').innerHTML = spin ? `<span class="dots">${html}</span>` : html;
}

/* 这一步没有询问 Laya：不要清空表格，只改表头提示。
 * 之前这里调 renderCmp({rows:[]}) 会把整张对比表擦掉，导致玩家永远
 * 看不到 Laya 与数学真值的对比（而那是本页面的核心）。 */
function markNoLaya(reason) {
  const tag = el('panelTag');
  if (tag) tag.textContent = reason;
  el('panel').classList.add('open');
}

function renderCmp(cmp) {
  lastCmp = cmp;
  const _tag = el('panelTag');
  if (_tag && cmp && cmp.rows && cmp.rows.length) _tag.textContent = '（点开/收起）';
  const tb = el('cmpBody');
  if (!cmp || !cmp.rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">这一步没有可判断的待判格（可能已经解完，或需要纯猜）。</td></tr>';
    el('cmpNote').textContent = cmp && cmp.note ? cmp.note : '';
    return;
  }
  tb.innerHTML = '';
  for (const row of cmp.rows) {
    const [r, c] = key2rc(row.k);
    const tr = document.createElement('tr');
    const sp = row.solverP, lp = row.layaP;
    const diff = (lp == null) ? null : Math.abs(lp - sp);
    const tag = (lp == null) ? '<span class="badge warn">没答</span>'
      : diff < 0.15 ? '<span class="badge ok">接近</span>'
      : diff < 0.4 ? '<span class="badge warn">偏差</span>'
      : '<span class="badge bad">差很远</span>';
    tr.innerHTML =
      `<td>R${r + 1}C${c + 1}</td>` +
      `<td style="color:var(--dim);font-size:11.5px">${row.desc.slice(0, 64)}…</td>` +
      `<td class="num">${(100 * sp).toFixed(1)}%</td>` +
      `<td class="num">${lp == null ? '—' : (100 * lp).toFixed(1) + '%'}</td>` +
      `<td>${tag}</td>`;
    tb.appendChild(tr);
  }
  let note = `数学真值来自完全枚举（本次共 ${cmp.solutions} 个合法方案，覆盖 ${cmp.enumCells} 格）。`;
  if (cmp.layaMs) note += ` Laya 一次前向传播 ${cmp.layaMs.toFixed(0)} ms（${cmp.keys} 个问题同批）。`;
  if (cmp.agreeTop != null) {
    note += ` 两边选中的「最安全格」${cmp.agreeTop ? '一致' : '不一致'}。`;
    note += ` 累计一致率 ${stats.total ? (100 * stats.agree / stats.total).toFixed(0) : 0}%`
         + `（${stats.agree}/${stats.total} 次）；Laya 选的格子里踩雷 ${stats.layaTop - stats.layaTopOK} 次。`;
  }
  el('cmpNote').textContent = note;
}

/* ==========================================================================
 * 走法规划 —— 预览与执行的**唯一来源**
 *
 * 设计要点：预览显示的走法和真正执行的走法必须一致。做法不是"两边各自算一遍
 * 再对齐"，而是只算一次：planMoves() 产生一个走法列表，UI 拿它画序号，
 * 执行器拿它走子。这样"预览 ≠ 执行"在结构上就不可能发生。
 * ======================================================================== */

/** 棋盘状态的轻量快照，用于在不改动真实棋盘的前提下推演后续几步 */
function snapshot(b) {
  return {
    hidden: new Set([...hiddenCells(b)].filter(k => !flagOf(b, k))),
    flags: new Set([...allFlagged(b)]),
    adj: (() => {                       // 已揭开格的数字，供描述约束用
      const m = new Map();
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        const x = b.cells[r][c];
        if (x.op) m.set(r + ',' + c, x.adj);
      }
      return m;
    })(),
    revealed: b.revealed
  };
}

function hiddenCells(b) {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = b.cells[r][c];
    if (!x.op) out.push(r + ',' + c);
  }
  return out;
}
function allFlagged(b) {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (b.cells[r][c].flag && !b.cells[r][c].op) out.push(r + ',' + c);
  }
  return out;
}
function flagOf(b, k) { const [r, c] = key2rc(k); return b.cells[r][c].flag; }

/**
 * 规划接下来的走法。
 *
 * 返回 {
 *   moves: [{kind:'flag'|'reveal', key, certain:bool, p, reason}],
 *   stuck: bool,          // 无法继续推理（无必然格且无可用概率）
 *   sol                   // 本次求解结果，供 UI 复用
 * }
 *
 * 走法顺序即执行顺序：
 *   1. 先标记所有"必然是雷"的格子（certain=true）
 *   2. 若有"必然安全"格 → 依次揭开（certain=true）
 *   3. 否则选概率最低的格猜测（certain=false，UI 必须标注为猜测）
 *
 * 注意：只在真正无法推理时才猜，且猜测不伪装成结论。
 */
function planMoves(b, depth, maxMoves) {
  const limit = maxMoves || 4;
  const out = {moves: [], stuck: false, sol: null, guessed: false, flags: []};
  if (b.over) return out;

  // 未开局：没有约束，走法就是"随机开一格"（首点保证不踩雷）。
  // Board.reveal → plant() 会保证首点 3x3 无雷，并对 0 区域做洪水填充，
  // 因此这一步之后通常就有大量已揭开格可推理。
  if (!b.started) {
    // 首点避开最外圈：这样 3x3 邻域完整，plant() 保证其全空 → 必然 flood fill，
    // 开局即可获得大量约束，而不是只揭开孤零零一格然后被迫盲猜。
    const r = 1 + Math.floor(Math.random() * Math.max(1, ROWS - 2));
    const c = 1 + Math.floor(Math.random() * Math.max(1, COLS - 2));
    out.moves.push({kind: 'reveal', key: r + ',' + c, certain: false, p: null, reason: '开局取信息'});
    return out;
  }

  // 在**克隆盘**上推演，绝不动真实棋盘
  const sim = cloneBoard(b);
  const ROUNDS = limit + 6;

  for (let round = 0; round < ROUNDS; round++) {
    if (sim.over) break;
    const sol = solve(sim, depth);
    // solve 可能返回 {error} —— 不能让整个预览崩掉
    if (!sol || !sol.mines || !sol.safe) { out.error = (sol && sol.error) || '求解失败'; break; }
    if (round === 0) out.sol = sol;

    // 必然是雷：记录为"自动标记"（不占预览序号），并在克隆盘上插旗，
    // 这样后续轮次的推理能利用它们。
    let flagged = 0;
    for (const k of sol.mines) {
      const [r, c] = key2rc(k);
      if (!sim.cells[r][c].flag && !sim.cells[r][c].op) {
        sim.toggleFlag(r, c);
        if (!solverFlags.has(k)) out.flags.push(k);
        flagged++;
      }
    }

    // 必然是安全：无论本轮是否插了旗，都要继续产出走法。
    // 早先写成"插旗就 continue 重来"，结果插旗与揭开交替触发、
    // 轮数在产出任何 move 之前就耗尽 —— 表现为"solve 明明给出 safe=1，
    // 预览却是 0 步、报无法继续推理"（实测地狱难度第 9 步）。
    if (sol.safe.size) {
      const list = [...sol.safe].filter(k => {
        const [r, c] = key2rc(k);
        return !sim.cells[r][c].op && !sim.cells[r][c].flag;
      });
      if (list.length) {
        list.sort((x, y) => pot(sim, y) - pot(sim, x));
        const k = list[0];
        out.moves.push({kind: 'reveal', key: k, certain: true, p: 0, reason: '约束推导为必然安全'});
        const [r, c] = key2rc(k);
        sim.reveal(r, c);
        if (out.moves.length >= limit) break;
        continue;
      }
    }

    if (flagged) continue;      // 只插了旗、没有安全格 → 下一轮重新求解

    // 推不出来 → 猜。候选是**全部**未知格，不只数字旁边
    const all = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const x = sim.cells[r][c];
      if (x.op || x.flag) continue;
      const k = r + ',' + c;
      const v = sol.probs.get(k);
      all.push({k, p: Number.isFinite(v) ? v : null});
    }
    if (!all.length) { out.stuck = true; break; }

    const gp = estimateGlobal(sim);
    for (const x of all) if (x.p === null) x.p = gp;
    all.sort((x, y) => (x.p - y.p) || (pot(sim, y.k) - pot(sim, x.k)));
    const best = all[0];
    out.moves.push({kind: 'reveal', key: best.k, certain: false, p: best.p,
                    reason: `无法唯一确定，选全局最低概率（${(100 * best.p).toFixed(1)}%）`});
    out.guessed = true;
    break;   // 猜测之后局面未知，不再继续推演后续序号
  }

  if (!out.moves.length && !out.error) out.stuck = true;
  return out;
}

/** 克隆棋盘 —— 供预览在不动真实盘面的前提下推演 */
function cloneBoard(b) {
  const c = new Board();
  c.cells = b.cells.map(row => row.map(x => ({mine: x.mine, op: x.op, flag: x.flag, adj: x.adj})));
  c.started = b.started; c.over = b.over; c.win = b.win;
  c.revealed = b.revealed; c.flags = b.flags; c.steps = b.steps;
  c.t0 = b.t0; c.elapsed = b.elapsed;
  return c;
}

/**
 * 执行一个走法。返回 {ok, hitMine}。
 * 这是**唯一**改动棋盘的入口，预览与自动模式都经由它。
 */
function applyMove(b, mv) {
  const [r, c] = key2rc(mv.key);
  if (mv.kind === 'flag') {
    if (!b.cells[r][c].flag && !b.cells[r][c].op) { b.toggleFlag(r, c); return {ok: true, hitMine: false}; }
    return {ok: false, hitMine: false};
  }
  // reveal
  const wasOver = b.over;
  const ok = b.reveal(r, c);
  const hitMine = !wasOver && b.over && !b.win;
  return {ok: ok !== false, hitMine};
}

/** 求解器自动插的旗（用于区分手动旗与算法旗） */
const solverFlags = new Set();
/** 当前预览的走法（下一个要执行的走法在 moves[0]） */
let preview = [];
let stuckNow = false;

/* ==========================================================================
 * 走一步
 * ======================================================================== */
async function doStep(useLaya) {
  if (busy || board.over) return;
  busy = true;
  el('btnAuto').disabled = true; el('btnStep').disabled = true;
  try {
    const depth = +el('depth').value;

    // ---- 未开局：先开一格取信息（首点保证不踩雷）----
    if (!board.started) {
      const pl = planMoves(board, depth, 1);
      const mv = pl.moves[0];
      if (!mv) return;
      applyMove(board, mv);
      board.steps++;
      setStatus(`开局：揭开 <b>R${key2rc(mv.key)[0] + 1}C${key2rc(mv.key)[1] + 1}</b> 取信息（首点保证不踩雷）。`);
      markNoLaya('开局还没有任何已知数字，无从判断，因此没有询问 Laya。');
      refreshPreview();
      return;
    }

    // ---- 规划：预览与执行共用同一次规划结果 ----
    const t0 = performance.now();
    const pl = planMoves(board, depth, 4);
    lastSolveMs = performance.now() - t0;
    perf.solve.push(lastSolveMs);
    if (perf.solve.length > 400) perf.solve.shift();

    const sol = pl.sol;
    const mv = pl.moves[0];
    if (!mv) {
      stuckNow = true;
      setStatus('无法继续推理：没有可走的格子了。');
      refreshPreview();
      return;
    }
    stuckNow = false;

    // ---- 必然是雷 → 只插旗，让玩家看到过程；本步不算揭格 ----
    if (mv.kind === 'flag') {
      const marks = pl.moves.filter(m => m.kind === 'flag').map(m => m.key);
      for (const k of marks) { if (applyMove(board, {kind: 'flag', key: k}).ok) solverFlags.add(k); }
      setStatus(`约束推导出 <b>${marks.length}</b> 个必然是雷 → 已自动插旗`
                + (sol && sol.safe.size ? `，同时还有 ${sol.safe.size} 个必然安全格待揭。` : '。'));
      markNoLaya('这一步由约束求解直接确定，没有询问 Laya。上表是最近一次 Laya 与数学真值的对比。');
      refreshPreview();
      paint();
      return;
    }

    // ---- 揭开一格 ----
    const [pr, pc] = key2rc(mv.key);

    if (mv.certain) {
      // 必然安全：直接揭，不需要问 Laya
      applyMove(board, mv);
      board.steps++;
      const n = pl.moves.filter(x => x.kind === 'reveal' && x.certain).length;
      const extra = n > 1 ? `（另有 ${n - 1} 格也可确定安全）` : '';
      setStatus(`约束求解出 <b>${n}</b> 个必然安全格 → 揭开 R${pr + 1}C${pc + 1} ${extra}`);
      markNoLaya('这一步由约束求解直接确定，没有询问 Laya。上表是最近一次 Laya 与数学真值的对比。');
      refreshPreview();
      paint();
      return;
    }

    // ---- 必须猜：如实标注，并把 Laya 的对比一并展示 ----
    const globalP = estimateGlobal(board);
    const keys = [];
    for (let r = 0; r < ROWS && keys.length < 14; r++)
      for (let c = 0; c < COLS && keys.length < 14; c++) {
        const x = board.cells[r][c];
        if (!x.op && !x.flag) {
          const k = r + ',' + c;
          if (hintWorthy(board, r, c)) keys.push(k);
        }
      }
    const useKeys = keys.length ? keys : [mv.key];

    const solverP = new Map(useKeys.map(k => {
      const v = sol ? sol.probs.get(k) : undefined;
      return [k, Number.isFinite(v) ? v : globalP];
    }));
    solverP.set(mv.key, mv.p);

    let layaRes = null, err = null;
    if (useLaya) {
      setStatus('正在求解数学约束并询问 Laya', true);
      try {
        layaRes = await askLaya(board, useKeys);
        lastInferMs = layaRes.ms;
        perf.infer.push(lastInferMs);
        if (perf.infer.length > 400) perf.infer.shift();
      } catch (e) { err = e.message; }
    }

    const rowsCmp = useKeys.map(k => {
      const [r, c] = key2rc(k);
      return {k, desc: describeCell(board, r, c), solverP: solverP.get(k),
              layaP: layaRes && layaRes.probs.has(k) ? layaRes.probs.get(k).p : null};
    }).sort((x, y) => x.solverP - y.solverP);

    const solverBest = mv.key;
    let layaBest = null;
    if (layaRes && layaRes.probs.size) {
      layaBest = [...layaRes.probs.entries()].reduce((m, e) => e[1].p < m[1].p ? e : m)[0];
      stats.total++;
      if (layaBest === solverBest) stats.agree++;
    }

    renderCmp({rows: rowsCmp, solverSafe: [], layaTop: layaBest, keys: useKeys.length,
      solutions: sol ? sol.solutions : 0, enumCells: sol ? sol.enumCells : 0,
      layaMs: layaRes && layaRes.ms, agreeTop: layaBest ? (layaBest === solverBest) : null,
      note: err ? ('Laya 调用失败：' + err + '（只显示数学真值）') : ''});

    const hit = applyMove(board, mv);
    board.steps++;
    if (layaBest) {
      stats.layaTop++;
      if (!(layaBest === solverBest && hit.hitMine)) stats.layaTopOK++;
    }

    const pickTxt = Number.isFinite(mv.p) ? (100 * mv.p).toFixed(1) + '%' : '未知';
    let msg = `无法唯一确定 → <b>猜测</b> 全局最低概率格 R${pr + 1}C${pc + 1}（P(雷) ${pickTxt}）`;
    if (layaBest) {
      const [lr, lc] = key2rc(layaBest);
      msg += `；Laya 认为是 R${lr + 1}C${lc + 1}` + (layaBest === solverBest ? '（一致）' : '（不一致）');
    }
    if (err) msg += ` · Laya 出错：${err.slice(0, 80)}`;
    setStatus(msg + (hit.hitMine ? ' —— 踩雷了。' : ''));
    refreshPreview();
    paint();
  } catch (e) {
    // 求解器抛错：不白屏、不卡死，保留棋盘并明确报错
    setStatus('求解出错：' + String(e && e.message || e).slice(0, 160) + '（棋盘已保留，可重开一局）');
    document.getElementById('stuck').textContent = '求解出错';
    document.getElementById('stuck').classList.add('on');
  } finally {
    busy = false;
    el('btnAuto').disabled = false; el('btnStep').disabled = false;
    if (board.over) { stopAuto(); clearPreview(); }
    paint();
  }
}

/** 是否值得把这一格列入"待判"（与已知数字相邻） */
function hintWorthy(b, r, c) {
  return b.nb(r, c).some(([rr, cc]) => b.cells[rr][cc].op && b.cells[rr][cc].adj > 0);
}

/** 重新计算并刷新 4 步预览 */
function refreshPreview() {
  if (board.over) { clearPreview(); return; }
  if (!board.started) { clearPreview(); return; }
  let pl;
  try { pl = planMoves(board, +el('depth').value, 4); }
  catch (e) { clearPreview(); return; }
  preview = pl.moves || [];
  stuckNow = preview.length === 0;
  const so = document.getElementById('stuck');
  if (stuckNow) { so.textContent = '无法继续推理'; so.classList.add('on'); }
  else so.classList.remove('on');
}

function clearPreview() {
  preview = [];
  stuckNow = false;
  const so = document.getElementById('stuck');
  if (so) so.classList.remove('on');
}

function pot(b, k) {   // 粗略估计开面大小：周围未揭开格数
  const [r, c] = key2rc(k);
  return b.nb(r, c).filter(([rr, cc]) => !b.cells[rr][cc].op).length;
}

/** 枚举覆盖不到时的兜底估计：全局剩余雷数 / 全局剩余格数 */
function estimateGlobal(b) {
  let hidden = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const x = b.cells[r][c];
    if (!x.op && !x.flag) hidden++;
  }
  const left = MINES - b.flags;
  return hidden > 0 ? Math.max(0, Math.min(1, left / hidden)) : 0;
}

/* ==========================================================================
 * 自动玩
 * ======================================================================== */
let timerId = null;
function startAuto() {
  auto = true;
  el('btnAuto').textContent = '暂停';
  setStatus('自动进行中');
  tick();
}
function stopAuto() {
  auto = false;
  el('btnAuto').textContent = '让 Laya 来玩';
  if (timerId) { clearTimeout(timerId); timerId = null; }
}
async function tick() {
  if (!auto) return;
  if (board.over) {
    clearPreview(); solverFlags.clear();
    setStatus(board.win ? '<b>通关了。</b>' : '<b>踩雷了。</b>');
    stopAuto(); paint(); return;
  }
  try {
    await doStep(true);
  } catch (e) {
    setStatus('这一步出错:' + String(e && e.message || e).slice(0, 140));
  }
  if (!auto) return;
  // 棋盘越大、已揭开越多就跑得越快；开局给足时间做首次约束求解
  timerId = setTimeout(tick, board.revealed > 40 ? 110 : (board.revealed > 8 ? 180 : 420));
}

/* ==========================================================================
 * 事件绑定
 * ======================================================================== */
el('board').addEventListener('click', e => {
  const d = e.target.closest('.cell'); if (!d || board.over) return;
  const r = +d.dataset.r, c = +d.dataset.c;
  if (board.cells[r][c].op) { board.chord(r, c); }
  else { board.reveal(r, c); board.steps++; }
  lastCmp = null; renderCmp(null);
  if (board.over) { clearPreview(); setStatus(board.win ? '<b>通关了。</b>' : '<b>踩雷了。</b>'); }
  else refreshPreview();
  paint();
});
el('board').addEventListener('contextmenu', e => {
  e.preventDefault();
  const d = e.target.closest('.cell'); if (!d || board.over) return;
  const r = +d.dataset.r, c = +d.dataset.c, k = r + ',' + c;
  // 玩家手动操作优先：这一格从此归玩家，求解器不再把它当自己的标记
  solverFlags.delete(k);
  board.toggleFlag(r, c);
  // 玩家的旗子是"已知条件"，会影响推理 → 立即重算预览
  refreshPreview();
  paint();
});
el('board').addEventListener('dblclick', e => {
  const d = e.target.closest('.cell'); if (!d || board.over) return;
  board.chord(+d.dataset.r, +d.dataset.c);
  if (board.over) clearPreview(); else refreshPreview();
  paint();
});
el('btnAuto').onclick = () => { if (auto) stopAuto(); else startAuto(); };
el('btnStep').onclick = () => doStep(true);
// 重新开局：保持当前棋盘尺寸与难度
el('btnReset').onclick = () => applyBoard(COLS, ROWS, MINES);
el('panelHd').onclick = () => el('panel').classList.toggle('open');

/* ---- 难度下拉 ---- */
(function initLevels() {
  const sel = el('level');
  sel.innerHTML = '';
  for (const l of LEVELS) {
    const o = document.createElement('option');
    o.value = l.id;
    // 每一项都标出总格数（需求：每个都要显示格子总数量）
    o.textContent = l.id === 'custom'
      ? '自定义 …'
      : `${l.name}  ${l.cols}×${l.rows}=${l.cols*l.rows} 格 · ${l.mines} 雷 · ${(100*l.mines/(l.cols*l.rows)).toFixed(1)}%`;
    sel.appendChild(o);
  }
  sel.value = 'default';
  sel.onchange = () => {
    const l = LEVEL_BY_ID[sel.value];
    if (!l) return;
    if (l.id === 'custom') {
      el('custombar').classList.add('on');
      updateCustomHint();
      return;                        // 只展开面板，不改棋盘
    }
    el('custombar').classList.remove('on');
    applyBoard(l.cols, l.rows, l.mines);
  };
})();

/* ---- 自定义面板 ---- */
['cCols','cRows','cMines'].forEach(id => {
  const n = el(id);
  if (n) n.oninput = updateCustomHint;
});
el('cApply').onclick = () => {
  if (!updateCustomHint()) return;
  applyBoard(+el('cCols').value, +el('cRows').value, +el('cMines').value);
  el('custombar').classList.remove('on');
};

/* 计时器 */
setInterval(() => { if (board.started && !board.over) el('sTime').textContent = fmt(board.elapsedMs()); }, 500);

/* ==========================================================================
 * 主题：深色 / 浅色 / 跟随系统（三态，持久化）
 *
 * - 深色/浅色：显式选择，写 localStorage
 * - 跟随系统：监听 prefers-color-scheme，系统切换时实时跟随
 * - 默认深色（需求：默认深色模式）
 * - 纯 CSS 变量实现，无外部资源，离线可用
 * ======================================================================== */
const THEME_KEY = 'laya-ms-theme';

function systemPrefersLight() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

/** 把 <html data-theme> 设为最终生效的主题（dark / light） */
function applyResolvedTheme(resolved) {
  if (resolved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

function resolveTheme(mode) {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  return systemPrefersLight() ? 'light' : 'dark';       // system
}

function setThemeMode(mode) {
  if (!['dark', 'light', 'system'].includes(mode)) mode = 'dark';
  try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
  applyResolvedTheme(resolveTheme(mode));
  const sel = el('theme');
  if (sel && sel.value !== mode) sel.value = mode;
  window.__themeMode = mode;
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  const mode = ['dark', 'light', 'system'].includes(saved) ? saved : 'dark';   // 默认深色
  setThemeMode(mode);

  const sel = el('theme');
  if (sel) sel.onchange = () => setThemeMode(sel.value);

  // 跟随系统：系统切换时实时生效（仅在 system 模式下改变外观）
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onSys = () => { if (window.__themeMode === 'system') applyResolvedTheme(resolveTheme('system')); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
})();

/* 窗口尺寸变化时重算格子大小（否则大棋盘在窄窗口里会溢出） */
let _rsz = null;
window.addEventListener('resize', () => {
  clearTimeout(_rsz);
  _rsz = setTimeout(() => { buildGrid(); paint(); }, 150);
});

/* 启动 */
buildGrid(); paint();

globalThis.__A={Board,planMoves,applyMove,setSize(c,r,m){COLS=c;ROWS=r;MINES=m;}};
