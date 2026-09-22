/* 测：随机布局下，一局"全程需要猜几次"以及"理论通关概率"的分布。
 * 用 oracle 走完整局（遇到雷就插旗跳过，只为统计，不改雷分布）。
 * 用法：node tools/lossdist.mjs [局数] [难度]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));

const N = parseInt(process.argv[2] || '60', 10);
const LV = process.argv[3] || 'hard';
const LEVELS = {default:[30,16,99], hard:[30,16,140], expert:[40,20,260]};
const [cols, rows, mines] = LEVELS[LV];

const res = [];
for (let g = 0; g < N; g++) {
  H.setSize(cols, rows, mines);
  const b = new H.Board();
  const p0 = H.planMoves(b, 3, 1);
  const rc = p0.moves[0].key.split(',').map(Number);
  b.reveal(rc[0], rc[1]);
  let guesses = 0, pWin = 1, ok = false;
  for (let s = 0; s < 12000; s++) {
    if (b.revealed >= cols*rows - mines) { ok = true; break; }
    if (b.over) break;
    const pl = H.planMoves(b, 3, 4);
    if (!pl.moves.length) break;
    const mv = pl.moves[0];
    const [r, c] = mv.key.split(',').map(Number);
    if (!mv.certain) {
      guesses++;
      pWin *= (1 - (Number.isFinite(mv.p) ? mv.p : 0.5));
      if (b.cells[r][c].mine) { b.cells[r][c].flag = true; b.flags++; continue; }
    }
    H.applyMove(b, mv);
  }
  if (ok) res.push({guesses, pWin});
}
res.sort((a,b)=>b.pWin-a.pWin);
const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
console.log(LV + '  ' + cols + 'x' + rows + '/' + mines + '  完成 ' + res.length + '/' + N + ' 局');
console.log('  全程猜测次数   中位数 ' + res[res.length>>1].guesses + '   平均 ' + avg(res.map(r=>r.guesses)).toFixed(1));
console.log('  理论通关概率   中位数 ' + (100*res[res.length>>1].pWin).toFixed(2) + '%   平均 ' + (100*avg(res.map(r=>r.pWin))).toFixed(2) + '%');
console.log('  最高 ' + (100*res[0].pWin).toFixed(1) + '%   最低 ' + (100*res[res.length-1].pWin).toFixed(3) + '%');
const th = [0.001, 0.01, 0.05, 0.10, 0.25, 0.50];
console.log('  可接受阈值 -> 命中率（用于布雷时筛选）:');
for (const t of th) {
  const hit = res.filter(r => r.pWin >= t).length;
  console.log('    pWin >= ' + (100*t).toFixed(1).padStart(5) + '%   ' + hit + '/' + res.length +
    '  = ' + (100*hit/res.length).toFixed(1) + '%');
}
