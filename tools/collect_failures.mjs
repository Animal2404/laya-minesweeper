/* 失败对局留痕：批量跑局，把失败局的完整过程落盘，供后续分析/进化使用。
 * 输出：tests/failures.jsonl  每行一个失败局
 *   {cols,rows,mines, steps:[{move,kind,p,reason}], mines:[...], deathAt, attribution}
 * 用法：node tools/collect_failures.mjs [总局数] [难度档]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));

const N = parseInt(process.argv[2] || '300', 10);
const LEVEL = process.argv[3] || 'default';
const LEVELS = {
  beginner: [9, 9, 10], easy: [16, 12, 26], medium: [20, 14, 50],
  default: [30, 16, 99], hard: [30, 16, 140], expert: [40, 20, 260],
};
const [cols, rows, mines] = LEVELS[LEVEL] || LEVELS.default;

const outPath = path.join(ROOT, 'tests', 'failures.jsonl');
const fd = fs.openSync(outPath, 'w');
let wins = 0, fails = 0, errs = 0;
const attrib = {};

for (let g = 0; g < N; g++) {
  try {
    H.setSize(cols, rows, mines);
    const b = new H.Board();
    const p0 = H.planMoves(b, 3, 1);
    if (!p0.moves.length) { errs++; continue; }
    const rc = p0.moves[0].key.split(',').map(Number);
    b.reveal(rc[0], rc[1]);

    const steps = [];
    let deathAt = -1, deathReason = null;
    for (let step = 0; step < 9000; step++) {
      if (b.over) break;
      const pl = H.planMoves(b, 3, 4);
      if (!pl.moves.length) { deathReason = 'stuck'; deathAt = step; break; }
      const mv = pl.moves[0];
      const [r, c] = mv.key.split(',').map(Number);
      const willDie = (!mv.certain) && b.cells[r][c].mine;
      steps.push({ step, key: mv.key, kind: mv.kind, certain: !!mv.certain,
                   p: Number.isFinite(mv.p) ? +mv.p.toFixed(4) : null,
                   reason: (mv.reason || '').slice(0, 60) });
      steps[steps.length - 1].willDie = willDie;
      if (H.applyMove(b, mv).hitMine) {
        deathAt = step;
        deathReason = mv.certain ? 'certain-wrong' : 'guess-hit';
        break;
      }
    }
    if (b.win) { wins++; continue; }
    fails++;
    attrib[deathReason || 'unknown'] = (attrib[deathReason || 'unknown'] || 0) + 1;
    // 收集真实雷分布
    const minesArr = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
      if (b.cells[r][c].mine) minesArr.push(r + ',' + c);
    fs.writeSync(fd, JSON.stringify({
      cols, rows, mines, level: LEVEL, game: g,
      deathAt, deathReason,
      revealedOnDeath: b.revealed,
      totalSafe: cols * rows - mines,
      steps, mines: minesArr,
    }) + '\n');
  } catch (e) { errs++; }
}
fs.closeSync(fd);
console.log('失败对局留痕：' + LEVEL + '  ' + N + ' 局');
console.log('  通关 ' + wins + '   失败 ' + fails + '   出错 ' + errs);
console.log('  失败归因：' + JSON.stringify(attrib));
console.log('  落盘：tests/failures.jsonl');
