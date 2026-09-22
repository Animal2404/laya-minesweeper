/* 通关率基准测试：按难度分档批量跑局，输出通关率 / 平均猜测 / 耗时。
 * 用法：node tools/bench.mjs [每档局数] [难度,难度,...]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));

const N = parseInt(process.argv[2] || '500', 10);
const LEVELS = {
  beginner: [9, 9, 10, '初级 9x9'], easy: [16, 12, 26, '简单 16x12'],
  medium: [20, 14, 50, '中级 20x14'], default: [30, 16, 99, '默认 30x16/99'],
  hard: [30, 16, 140, '困难 30x16/140'], expert: [40, 20, 260, '专家 40x20/260'],
};
const which = (process.argv[3] || 'beginner,easy,default,hard').split(',');

function play(cols, rows, mines, wantSteps) {
  H.setSize(cols, rows, mines);
  const b = new H.Board();
  const p0 = H.planMoves(b, 3, 1);
  if (!p0.moves.length) return null;
  const rc = p0.moves[0].key.split(',').map(Number);
  b.reveal(rc[0], rc[1]);
  let g = 0, ded = 0;
  for (let step = 0; step < 9000; step++) {
    if (b.over) return {win: b.win, g, ded};
    const pl = H.planMoves(b, 3, 4);
    if (!pl.moves.length) return {win: false, g, ded, stuck: 1};
    const mv = pl.moves[0];
    if (mv.certain) ded++; else g++;
    if (H.applyMove(b, mv).hitMine) return {win: false, g, ded};
  }
  return {win: false, g, ded, timeout: 1};
}

console.log('难度               通关率      通关/总数    平均猜测   平均推理   每局耗时');
const rows = [];
for (const lv of which) {
  const L = LEVELS[lv]; if (!L) continue;
  const [cols, rws, mines, name] = L;
  let win = 0, n = 0, g = 0, d = 0, err = 0;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const r = play(cols, rws, mines);
    if (!r) { err++; continue; }
    n++; if (r.win) win++; g += r.g; d += r.ded;
  }
  const dt = (Date.now() - t0) / Math.max(1, n);
  const rate = 100 * win / Math.max(1, n);
  rows.push({name, rate, win, n, g: g / Math.max(1,n), d: d / Math.max(1,n), dt});
  console.log('%-16s  %s%%   %s/%s   %s   %s   %sms',
    name, rate.toFixed(1).padStart(6), String(win).padStart(4), String(n).padEnd(5),
    (g/Math.max(1,n)).toFixed(2).padStart(6), (d/Math.max(1,n)).toFixed(0).padStart(6),
    dt.toFixed(0).padStart(6));
}
console.log(JSON.stringify(rows));
