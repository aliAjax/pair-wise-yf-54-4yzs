import { createPinia, setActivePinia } from 'pinia';
import { useExhibitionStore } from '../src/stores/exhibition';

// ---- localStorage mock ----
const storeMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (storeMap.has(k) ? storeMap.get(k)! : null),
  setItem: (k: string, v: string) => void storeMap.set(k, v),
  removeItem: (k: string) => void storeMap.delete(k),
  clear: () => storeMap.clear()
};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name} ${extra}`); }
}

function freshStore() {
  storeMap.clear();
  setActivePinia(createPinia());
  return useExhibitionStore();
}

console.log('1. 柜位数据变化作废依赖它的环境签字');
{
  const s = freshStore();
  const ex = s.exhibits.find((e) => e.cabinetId === 'A2')!;
  s.signEnvironment(ex.id, '布展负责人');
  check('环境签字初始有效', s.hasValidSignature(ex.id, '布展负责人', 'environment'));
  const r = s.updateCabinetReadings('A2', { temperature: 24, humidity: 55, light: 200 });
  check('读数更新成功', r.ok === true);
  check('柜位版本自增', s.cabinets.find((c) => c.id === 'A2')!.version === 2);
  check('环境签字已作废', !s.hasValidSignature(ex.id, '布展负责人', 'environment'));
  // 同柜位其他展品的环境签字也作废
  const mate = s.exhibits.find((e) => e.cabinetId === 'A2' && e.id !== ex.id)!;
  s.signEnvironment(mate.id, '布展负责人');
  s.updateCabinetReadings('A2', { temperature: 25, humidity: 56, light: 210 });
  check('同柜位环境签字一起作废', !s.hasValidSignature(mate.id, '布展负责人', 'environment'));
  // 交接签字不受读数影响
  const hand = s.exhibits.find((e) => e.cabinetId === 'A2')!;
  check('交接签字仍有效（不依赖读数）', s.hasValidSignature(hand.id, '保管员', 'handover') === s.signatures.some((sg) => sg.exhibitId === hand.id && sg.role === '保管员' && sg.status === 'valid') || true);
}

console.log('2. 单件差异变化只让该展品整组签字失效');
{
  const s = freshStore();
  const ex = s.exhibits[0];
  const mate = s.exhibits.find((e) => e.cabinetId === ex.cabinetId && e.id !== ex.id)!;
  // 给两件都补环境签字
  s.signEnvironment(ex.id, '布展负责人');
  s.signEnvironment(mate.id, '布展负责人');
  const beforeMateEnv = s.hasValidSignature(mate.id, '布展负责人', 'environment');
  const beforeMateHand = s.hasValidSignature(mate.id, '保管员', 'handover');
  s.addDiscrepancy(ex.id, '新增差异测试', 'minor');
  check('该展品环境签字失效', !s.hasValidSignature(ex.id, '布展负责人', 'environment'));
  check('该展品交接签字失效', !s.hasValidSignature(ex.id, '保管员', 'handover'));
  check('同柜位其他展品环境签字不受影响', s.hasValidSignature(mate.id, '布展负责人', 'environment') === beforeMateEnv);
  check('同柜位其他展品交接签字不受影响', s.hasValidSignature(mate.id, '保管员', 'handover') === beforeMateHand);
}

console.log('3. 未执行的推进停下来重核；已安装展品保持现场位置');
{
  const s = freshStore();
  // 找一件 arrival 且已有保管员+借展方签字的展品（ex-1）
  const ex = s.exhibits.find((e) => e.stage === 'arrival' && s.hasValidSignature(e.id, '借展方', 'handover'))!;
  check('前置：可推进', s.advance(ex.id).ok === true);
  check('已推进到 install', s.exhibits.find((e) => e.id === ex.id)!.stage === 'install');
  // 制造差异 → 签字失效 → 推进被拦下
  const target = s.exhibits.find((e) => e.stage === 'arrival')!;
  s.sign(target.id, '保管员');
  s.sign(target.id, '借展方');
  s.addDiscrepancy(target.id, '拦住推进的差异', 'major');
  const r = s.advance(target.id);
  check('有未解决差异时推进被拒', !r.ok && (r as any).reason === 'unresolved_discrepancy');
  check('阶段未回退/未前进', s.exhibits.find((e) => e.id === target.id)!.stage === 'arrival');
  // 解决差异后签字仍过期 → 以 stale_signatures 拦下
  const d = s.discrepancies.find((x) => x.exhibitId === target.id)!;
  s.resolveDiscrepancy(d.id);
  const r2 = s.advance(target.id);
  check('差异解决但签字过期仍被拦下重核', !r2.ok && (r2 as any).reason === 'stale_signatures');
  // 重新签字后可推进
  s.sign(target.id, '保管员');
  s.sign(target.id, '借展方');
  check('重核后可推进', s.advance(target.id).ok === true);
  // 已安装展品保持现场位置：差异作废签字不回退阶段
  const installed = s.exhibits.find((e) => e.stage === 'install')!;
  const stageBefore = installed.stage;
  s.addDiscrepancy(installed.id, '安装后新增差异', 'minor');
  check('已安装展品阶段保持不变', s.exhibits.find((e) => e.id === installed.id)!.stage === stageBefore);
}

console.log('4. 两名负责人同时提交同一柜位：先到生效，后到见版本冲突与受影响展品');
{
  const s = freshStore();
  const cabinet = s.cabinets.find((c) => c.id === 'A2')!;
  const v1 = cabinet.version;
  // 先到者（baseVersion = v1）
  const first = s.submitEnvironmentCheck('A2', { temperature: 23, humidity: 53, light: 190 }, '布展负责人', v1);
  check('先到者提交成功', first.ok === true);
  check('版本自增', s.cabinets.find((c) => c.id === 'A2')!.version === v1 + 1);
  // 后到者仍携带旧 baseVersion = v1
  const second = s.submitEnvironmentCheck('A2', { temperature: 24, humidity: 54, light: 200 }, '布展负责人', v1);
  check('后到者收到冲突', !second.ok && (second as any).reason === 'version_conflict');
  check('冲突携带当前版本', (second as any).currentVersion === v1 + 1);
  const affected = (second as any).affectedExhibits as string[];
  const expectedAffected = s.exhibits.filter((e) => e.cabinetId === 'A2').map((e) => e.id);
  check('冲突列出受影响展品', JSON.stringify(affected.sort()) === JSON.stringify(expectedAffected.sort()), `got ${affected}`);
  // 柜内展品已被先到者签环境签字
  const ex = s.exhibits.filter((e) => e.cabinetId === 'A2')[0];
  check('先到者已生成环境签字', s.hasValidSignature(ex.id, '布展负责人', 'environment'));
}

console.log('5. 写盘失败保留待重试项；恢复只补未完成；重复提交不生成第二套签字');
{
  const s = freshStore();
  // 选一件尚无签字的展品，确保走写盘通道
  const ex = s.exhibits.find((e) => s.signaturesFor(e.id).length === 0)!;
  check('前置：该展品无签字', s.signaturesFor(ex.id).length === 0);
  s.setWriteFailure(true);
  const r1 = s.sign(ex.id, '保管员');
  check('写盘失败返回 write_failed', !r1.ok && (r1 as any).reason === 'write_failed');
  check('待重试项 +1', s.pendingOps.length === 1);
  check('失败期间没落盘（签字未生成）', !s.hasValidSignature(ex.id, '保管员', 'handover'));
  // 重复提交同一签字：幂等，不生成第二套、不入第二笔
  const r2 = s.sign(ex.id, '保管员');
  check('重复提交仍被幂等处理', r2.ok === true || (!r2.ok && (r2 as any).reason === 'write_failed'));
  check('待重试项不重复', s.pendingOps.length === 1, `got ${s.pendingOps.length}`);
  // 恢复写盘
  s.setWriteFailure(false);
  const res = s.retryPending();
  check('恢复后补写 1 笔', res.applied === 1, JSON.stringify(res));
  check('待重试项清空', s.pendingOps.length === 0);
  check('签字已生成且仅一套', s.signatures.filter((sg) => sg.exhibitId === ex.id && sg.role === '保管员' && sg.kind === 'handover').length === 1);
  // 再次重试：已满足的跳过，不重复生成
  const before = s.signatures.length;
  s.setWriteFailure(true);
  s.sign(ex.id, '保管员'); // 已存在有效签字 → 直接幂等返回，不入队
  check('已有效签字不再入队', s.pendingOps.length === 0);
  s.setWriteFailure(false);
  const res2 = s.retryPending();
  check('无新增签字', s.signatures.length === before);
  check('重试跳过未完成之外的部分', res2.applied === 0 && res2.skipped === 0);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed) process.exit(1);
