import { build } from 'esbuild';

await build({
  entryPoints: ['/workspace/src/stores/exhibition.ts'],
  bundle: true,
  format: 'esm',
  external: ['pinia', 'vue'],
  outfile: '/workspace/node_modules/.cache/store.verify.bundle.mjs',
  logLevel: 'silent'
});

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear()
};

const { useExhibitionStore, signOffValid } = await import('/workspace/node_modules/.cache/store.verify.bundle.mjs');
const { createPinia, setActivePinia } = await import('/workspace/node_modules/pinia/dist/pinia.mjs');
setActivePinia(createPinia());
const store = useExhibitionStore();

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name}`); }
}
const validFor = (exId) => store.signoffs.filter((s) => s.exhibitId === exId && store.isValid(s));
const validEnvOf = (exId) => validFor(exId).filter((s) => s.kind === 'environment');
const ex = (id) => store.exhibits.find((e) => e.id === id);

console.log('1. 柜位读数变化只作废依赖它的环境签字');
const a2 = store.cabinets.find((c) => c.id === 'cab-a2');
const target = store.exhibitsInCabinet('cab-a2').find((e) => e.stage === 'install' && validEnvOf(e.id).length > 0);
const handoverBefore = validFor(target.id).filter((s) => s.kind === 'handover').length;
const r1 = store.submitCabinetVerification('cab-a2', a2.version, { temperature: 21, humidity: 51, light: 150 }, '布展负责人·王');
check('版本一致时提交生效', r1.ok === true);
check('柜位版本 +1', a2.version === 4);
check('读数变更后旧环境签字作废', store.signOffsFor(target.id).some((s) => s.kind === 'environment' && !store.isValid(s)));
check('新环境签字基于 v4 生效', validEnvOf(target.id).some((s) => s.cabinetVersion === 4));
check('同柜点交签字不受柜位变化影响', validFor(target.id).filter((s) => s.kind === 'handover').length === handoverBefore);
const b1validBefore = store.exhibitsInCabinet('cab-b1').flatMap((e) => validFor(e.id)).length;
check('其他柜位展品签字照旧', store.exhibitsInCabinet('cab-b1').flatMap((e) => validFor(e.id)).length === b1validBefore);

console.log('2. 单件差异变化只让该展品整组签字失效');
const victim2 = ex('ex-3'); // 到场点交阶段，cab-b1，有两条有效点交签字
const groupSize = validFor(victim2.id).length;
const peer = ex('ex-11'); // 同柜另一件
const peerValid = validFor(peer.id).length;
store.addDiscrepancy(victim2.id, '测试差异：锦盒受潮', 'minor');
check('该展品整组签字失效', validFor(victim2.id).length === 0 && groupSize === 2);
check('差异版本 +1', victim2.discrepancyVersion === 2);
check('同柜其他展品签字不受影响', validFor(peer.id).length === peerValid && peerValid > 0);
check('该展品被标记待重核', store.needsRecheck(victim2.id) === true);

console.log('3. 推进门禁：带过期结果被拦下，重签后放行；已安装位置保持');
const victim3 = ex('ex-11'); // 布展核验阶段，cab-b1，环境签字种子数据已过期
store.addDiscrepancy(victim3.id, '测试差异：展签错位', 'minor');
const blocked = store.advanceBlockers(victim3.id);
check('未解决差异 + 签字作废都被列为拦阻原因', blocked.some((b) => b.includes('未解决差异')) && blocked.some((b) => b.includes('已作废')));
store.advance(victim3.id);
check('有拦阻时推进不执行', victim3.stage === 'install');
store.resolveDiscrepancy(store.discrepancies.find((d) => d.exhibitId === victim3.id && !d.resolved).id);
check('确认解决差异同样使整组失效（需重签）', validFor(victim3.id).length === 0);
store.sign(victim3.id, '保管员', 'handover');
store.submitCabinetVerification('cab-b1', store.cabinetOf(victim3).version, { ...store.cabinetOf(victim3).reading }, '布展负责人·王');
check('重签后拦阻清空', store.advanceBlockers(victim3.id).length === 0);
store.advance(victim3.id);
check('重签后推进执行', victim3.stage === 'return');
check('安装到位写入现场位置', typeof victim3.position === 'string' && victim3.position.includes('M011号位'));
const pos = victim3.position;
store.addDiscrepancy(victim3.id, '测试差异：玻璃反光', 'minor');
check('已安装展品签字再失效时位置保持', victim3.position === pos && validFor(victim3.id).length === 0);

console.log('4. 两名负责人同时提交同一柜位：只有一方生效');
const c3 = store.cabinets.find((c) => c.id === 'cab-c3');
const baseV = c3.version;
const win = store.submitCabinetVerification('cab-c3', baseV, { temperature: 20.5, humidity: 55, light: 50 }, '布展负责人·王');
const lose = store.submitCabinetVerification('cab-c3', baseV, { temperature: 19.5, humidity: 54, light: 45 }, '布展负责人·李');
check('先到者生效', win.ok === true && c3.version === baseV + 1 && c3.reading.temperature === 20.5);
check('后到者收到版本冲突', lose.ok === false && lose.conflict.expected === baseV && lose.conflict.current === baseV + 1);
check('冲突方读数未落地', c3.reading.light === 50);
check('冲突返回受影响展品清单', Array.isArray(lose.conflict.affected));
check('冲突记入核验账', store.ledger.some((e) => e.type === 'conflict' && e.message.includes('布展负责人·李')));

console.log('5. 写盘失败保留待重试，恢复只补未完成，重复提交不生成第二套签字');
store.toggleWriteFailure();
const target5 = ex('ex-3');
store.sign(target5.id, '保管员', 'handover');
store.sign(target5.id, '保管员', 'handover'); // 重复提交
store.sign(target5.id, '保管员', 'handover'); // 再次重复提交
const validKeeperSigns = () => validFor(target5.id).filter((s) => s.role === '保管员' && s.stage === 'arrival');
check('故障期间变更进入待重试队列', store.outbox.length === 1);
check('重复提交不生成第二套有效签字', validKeeperSigns().length === 1);
check('重复提交不生成第二条待重试项', store.outbox.length === 1);
store.toggleWriteFailure(); // 恢复并自动补写
check('恢复后队列清空', store.outbox.length === 0 && store.lastWriteError === null);
check('恢复补写记入核验账', store.ledger.some((e) => e.type === 'storage' && e.message.includes('补完成 1 条')));
store.retryFlush();
check('恢复后重复重试不产生第二套签字', validKeeperSigns().length === 1);
check('签字有效性判定函数可用', signOffValid(store.cabinets, store.exhibits, validKeeperSigns()[0]) === true);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
