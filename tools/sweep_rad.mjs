/* 首点安全区半径 × 各难度 的对照表（同口径、可复现）。
 * 用法：node tools/sweep_rad.mjs <rad> [局数]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));
const RAD = parseInt(process.argv[2] || '2', 10);
const N = parseInt(process.argv[3] || '300', 10);
global.window.__rad = RAD;
const LEVELS = [
  [9,9,10,'初级 9x9'], [16,12,26,'简单 16x12'], [20,14,50,'中级 20x14'],
  [30,16,99,'默认 30x16/99'], [30,16,140,'困难 30x16/140'],
];
console.log('RAD=' + RAD + '   每档 ' + N + ' 局');
console.log('难度              通关率      通关/总数    平均猜测   每局耗时');
for (const [cols,rows,mines,name] of LEVELS) {
  let win=0,n=0,g=0;
  const t0=Date.now();
  for (let i=0;i<N;i++){
    H.setSize(cols,rows,mines);
    const b=new H.Board();
    const p0=H.planMoves(b,3,1);
    if(!p0.moves.length)continue;
    const rc=p0.moves[0].key.split(',').map(Number);
    b.reveal(rc[0],rc[1]);
    let gg=0;
    for(let s=0;s<9000;s++){
      if(b.over)break;
      const pl=H.planMoves(b,3,4);
      if(!pl.moves.length)break;
      const mv=pl.moves[0];
      if(!mv.certain)gg++;
      if(H.applyMove(b,mv).hitMine)break;
    }
    n++; if(b.win)win++; g+=gg;
  }
  console.log('%-16s  %s%%   %s/%s   %s   %sms',
    name, (100*win/Math.max(1,n)).toFixed(1).padStart(6),
    String(win).padStart(4), String(n).padEnd(5),
    (g/Math.max(1,n)).toFixed(2).padStart(6),
    ((Date.now()-t0)/Math.max(1,n)).toFixed(0).padStart(6));
}
