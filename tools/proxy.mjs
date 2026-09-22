/* 找"能预测布局质量"的低成本指标。
 * 目标：不跑完整局就能判断这副雷好不好（pWin 高不高）。
 * 用法：node tools/proxy.mjs [局数] [难度]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));
const N = parseInt(process.argv[2] || '50', 10);
const LV = process.argv[3] || 'hard';
const LEVELS = {default:[30,16,99], hard:[30,16,140], expert:[40,20,260]};
const [cols, rows, mines] = LEVELS[LV];
const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

const recs = [];
for (let g = 0; g < N; g++) {
  H.setSize(cols, rows, mines);
  const b = new H.Board();
  const p0 = H.planMoves(b, 3, 1);
  const rc = p0.moves[0].key.split(',').map(Number);
  b.reveal(rc[0], rc[1]);
  const opened = b.revealed;
  const sol = H.solve(b, 3);
  const certain = sol ? (sol.safe.size + sol.mines.size) : 0;
  const probed = sol ? sol.probs.size : 0;
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
  if (ok) recs.push({opened, certain, probed, guesses, pWin});
}
function corr(xs, ys) {
  const n = xs.length, mx = avg(xs), my = avg(ys);
  let num=0, dx=0, dy=0;
  for (let i=0;i<n;i++){ num+=(xs[i]-mx)*(ys[i]-my); dx+=(xs[i]-mx)**2; dy+=(ys[i]-my)**2; }
  return dx>0&&dy>0 ? num/Math.sqrt(dx*dy) : 0;
}
console.log(LV + ' ' + cols + 'x' + rows + '/' + mines + '  完成 ' + recs.length + '/' + N);
console.log('  相关系数（越接近 1 越能当代理）:');
console.log('    开局揭开数  vs pWin     ' + corr(recs.map(r=>r.opened), recs.map(r=>r.pWin)).toFixed(3));
console.log('    必然格数    vs pWin     ' + corr(recs.map(r=>r.certain), recs.map(r=>r.pWin)).toFixed(3));
console.log('    有概率格数  vs pWin     ' + corr(recs.map(r=>r.probed), recs.map(r=>r.pWin)).toFixed(3));
console.log('    开局揭开数  vs 猜测次数 ' + corr(recs.map(r=>r.opened), recs.map(r=>r.guesses)).toFixed(3));
function q(key, label) {
  const s = recs.slice().sort((a,b)=>b[key]-a[key]);
  const k = Math.max(1, Math.floor(s.length/4));
  const top = s.slice(0,k), bot = s.slice(-k);
  console.log('  ' + label + ': 前25% pWin ' + (100*avg(top.map(r=>r.pWin))).toFixed(2) +
    '% / 后25% pWin ' + (100*avg(bot.map(r=>r.pWin))).toFixed(2) + '%');
}
q('opened','按开局揭开数');
q('certain','按必然格数');
