/* 回归测试：重放 tests/deduction_cases.json，验证求解器的「必然判定」没有判错。
 * 用例来自真实对局快照 —— 若某条用例以前判得出、现在判不出或判错，测试失败。
 * 用法：node tools/run_regression.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const f = path.join(ROOT, 'tests', 'deduction_cases.json');
if (!fs.existsSync(f)) { console.error('缺少 ' + f); process.exit(2); }
const { cases } = JSON.parse(fs.readFileSync(f, 'utf8'));
const H = require(path.join(ROOT, 'tests', '_harness.cjs'));

let pass = 0, failMissing = 0, failWrong = 0;
const failures = [];

for (const cs of cases) {
  H.setSize(cs.cols, cs.rows, cs.mines);
  const b = new H.Board();
  b.cells = Array.from({length: cs.rows}, () => Array.from({length: cs.cols},
    () => ({mine: false, op: false, flag: false, adj: 0})));
  // 还原盘面：已揭开格的数字
  for (const [r, c, adj] of cs.revealed) { b.cells[r][c].op = true; b.cells[r][c].adj = adj; }
  for (const [r, c] of cs.flags) b.cells[r][c].flag = true;
  b.revealed = cs.revealed.length;
  b.flags = cs.flags.length;
  b.started = true;
  // 关键：找出快照对应的真实雷分布，用来判「判错了没有」
  // —— 用例只存了判定结果，所以这里用一个自洽性检查：
  //    求解器给出的 safe/mines 必须与「快照 + 自身约束」一致
  const sol = H.solve(b, 3);
  if (!sol || !sol.probs) { failMissing++; failures.push({cs, why: 'solve 无结果'}); continue; }
  const missingSafe = cs.expectSafe.filter(k => !sol.safe.has(k));
  const missingMine = cs.expectMine.filter(k => !sol.mines.has(k));
  if (missingSafe.length || missingMine.length) {
    failMissing++;
    if (failures.length < 8) failures.push({cs, why:
      '漏判 safe=' + missingSafe.length + ' mine=' + missingMine.length});
    continue;
  }
  // 反向检查：新判出的必然格不能与旧判定冲突
  const conflict = [...sol.safe].filter(k => cs.expectMine.includes(k))
    .concat([...sol.mines].filter(k => cs.expectSafe.includes(k)));
  if (conflict.length) {
    failWrong++;
    if (failures.length < 8) failures.push({cs, why: '判定冲突 ' + conflict.slice(0,3).join(' ')});
    continue;
  }
  pass++;
}

console.log('回归测试（必然判定）：');
console.log('  用例总数 : ' + cases.length);
console.log('  通过     : ' + pass);
console.log('  漏判     : ' + failMissing);
console.log('  判定冲突 : ' + failWrong);
for (const x of failures.slice(0, 6)) {
  console.log('    ! ' + x.cs.cols + 'x' + x.cs.rows + '/' + x.cs.mines + '  ' + x.why);
}
console.log((failMissing === 0 && failWrong === 0) ? '  => 全部通过 ✓' : '  => 有失败 ✗');
process.exit((failMissing === 0 && failWrong === 0) ? 0 : 1);
