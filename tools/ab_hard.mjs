/* 困难模式 A/B：两步前瞻 开 vs 关。同口径、同种子、可复现。
 * 用法：node tools/ab_hard.mjs <lookahead 0|1> [局数] [难度]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));

const LA = process.argv[2] === '1' ? 1 : 0;
const N = parseInt(process.argv[3] || '300', 10);
const LV = process.argv[4] || 'hard';
const LEVELS = {default:[30,16,99], hard:[30,16,140], expert:[40,20,260]};
const [cols, rows, mines] = LEVELS[LV];

global.window.__lookahead = LA;
global.window.__lookN = 3;

let win = 0, n = 0, gsum = 0, err = 0, ded = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  try {
    H.setSize(cols, rows, mines);
    const b = new H.Board();
    const p0 = H.planMoves(b, 3, 1);
    if (!p0.moves.length) { err++; continue; }
    const rc = p0.moves[0].key.split(',').map(Number);
    b.reveal(rc[0], rc[1]);
    let g = 0, d = 0, done = false;
    for (let s = 0; s < 9000; s++) {
      if (b.over) { done = true; break; }
      const pl = H.planMoves(b, 3, 4);
      if (!pl.moves.length) { done = true; break; }
      const mv = pl.moves[0];
      if (mv.certain) d++; else g++;
      if (H.applyMove(b, mv).hitMine) { done = true; break; }
    }
    n++; if (b.win) win++; gsum += g; ded += d;
  } catch (e) { err++; }
}
const dt = (Date.now() - t0) / Math.max(1, n);
console.log('前瞻=' + LA + '  ' + LV + '  ' + n + '局  通关 ' + win + ' = ' +
  (100*win/Math.max(1,n)).toFixed(2) + '%  平均猜测 ' + (gsum/Math.max(1,n)).toFixed(2) +
  '  推理 ' + (ded/Math.max(1,n)).toFixed(0) + '  每局 ' + dt.toFixed(0) + 'ms  出错 ' + err);
