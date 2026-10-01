import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type SignKind = 'handover' | 'environment';

export interface EnvironmentReading { temperature: number; humidity: number; light: number }
export interface Cabinet { id: string; name: string; reading: EnvironmentReading; version: number }
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  cabinetId: string;
  stage: Stage;
  /** 安装到位后的现场位置，一旦写入任何核验作废都不清除 */
  position: string | null;
  installedAt: string | null;
  /** 差异项每次新增/解决都会 +1，使该展品整组签字失效 */
  discrepancyVersion: number;
}
export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean }
export interface SignOff {
  /** 幂等键：同一展品/阶段/角色/类型在同一版本组合下重复提交只会有一条 */
  id: string;
  exhibitId: string;
  stage: Stage;
  role: string;
  kind: SignKind;
  /** 签字时所依据的柜位读数版本（环境签字受柜位数据变化约束） */
  cabinetVersion: number;
  /** 签字时所依据的展品差异版本（任何差异变化使整组签字失效） */
  discrepancyVersion: number;
  signedAt: string;
}
export type LedgerType = 'sign' | 'cabinet' | 'conflict' | 'discrepancy' | 'advance' | 'blocked' | 'storage' | 'register';
export interface LedgerEntry { seq: number; at: string; type: LedgerType; message: string }
export interface OutboxOp { key: string; label: string; at: string }
export interface ConflictInfo { expected: number; current: number; affected: { id: string; code: string }[] }

export const STAGE_ORDER: Stage[] = ['arrival', 'install', 'return'];
export const STAGE_LABELS: Record<Stage, string> = { arrival: '到场点交', install: '布展核验', return: '闭展归还' };
export const STAGE_REQUIREMENTS: Record<Stage, { role: string; kind: SignKind }[]> = {
  arrival: [{ role: '保管员', kind: 'handover' }, { role: '借展方', kind: 'handover' }],
  install: [{ role: '保管员', kind: 'handover' }, { role: '布展负责人', kind: 'environment' }],
  return: [{ role: '保管员', kind: 'handover' }, { role: '借展方', kind: 'handover' }]
};

/** 签字是否仍然有效：差异版本必须一致，环境签字还要求柜位版本一致 */
export function signOffValid(cabinets: Cabinet[], exhibits: Exhibit[], so: SignOff): boolean {
  const exhibit = exhibits.find((item) => item.id === so.exhibitId);
  if (!exhibit || exhibit.discrepancyVersion !== so.discrepancyVersion) return false;
  if (so.kind !== 'environment') return true;
  const cabinet = cabinets.find((item) => item.id === exhibit.cabinetId);
  return cabinet?.version === so.cabinetVersion;
}

interface State {
  cabinets: Cabinet[];
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  signoffs: SignOff[];
  ledger: LedgerEntry[];
  outbox: OutboxOp[];
  seq: number;
  writeFailure: boolean;
  lastWriteError: string | null;
}

const STORAGE_KEY = 'yf54-exhibition-ledger-v1';

function buildSeed(): State {
  const cabinets: Cabinet[] = [
    { id: 'cab-a2', name: 'A2 温湿展柜', reading: { temperature: 20.5, humidity: 50, light: 150 }, version: 3 },
    { id: 'cab-b1', name: 'B1 开放展区', reading: { temperature: 22, humidity: 55, light: 300 }, version: 2 },
    { id: 'cab-c3', name: 'C3 书画专柜', reading: { temperature: 20, humidity: 55, light: 50 }, version: 1 }
  ];
  const cabinetOf = (index: number) => cabinets[[0, 0, 1, 2][index % 4]].id;
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => {
    const stage: Stage = index < 8 ? 'arrival' : index < 18 ? 'install' : 'return';
    const code = `M${String(index + 1).padStart(3, '0')}`;
    const installed = stage === 'return';
    return {
      id: `ex-${index + 1}`,
      code,
      name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
      lender: index % 2 ? '西北博物馆' : '私人借展方',
      cabinetId: cabinetOf(index),
      stage,
      position: installed ? `${cabinets.find((c) => c.id === cabinetOf(index))!.name} · ${code}号位` : null,
      installedAt: installed ? '2026-09-28T10:00:00.000Z' : null,
      discrepancyVersion: 1
    };
  });
  const signoffs: SignOff[] = [];
  const seedSign = (exhibit: Exhibit, stage: Stage, role: string, kind: SignKind, cabinetVersion: number, minute: number) => {
    signoffs.push({
      id: `${exhibit.id}:${stage}:${role}:${kind}@c${cabinetVersion}d${exhibit.discrepancyVersion}`,
      exhibitId: exhibit.id, stage, role, kind,
      cabinetVersion, discrepancyVersion: exhibit.discrepancyVersion,
      signedAt: `2026-09-30T09:${String(minute % 60).padStart(2, '0')}:00.000Z`
    });
  };
  exhibits.forEach((exhibit, index) => {
    const cabinet = cabinets.find((c) => c.id === exhibit.cabinetId)!;
    if (index < 5) {
      seedSign(exhibit, 'arrival', '保管员', 'handover', cabinet.version, index);
      seedSign(exhibit, 'arrival', '借展方', 'handover', cabinet.version, index + 1);
    }
    if (exhibit.stage !== 'arrival') {
      seedSign(exhibit, 'install', '保管员', 'handover', cabinet.version, index + 2);
      // ex-11 的环境签字基于旧柜位版本，演示“柜位读数一变即作废”
      const stale = exhibit.id === 'ex-11';
      seedSign(exhibit, 'install', '布展负责人', 'environment', stale ? cabinet.version - 1 : cabinet.version, index + 3);
    }
  });
  return {
    cabinets,
    exhibits,
    discrepancies: [
      { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
      { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
    ],
    signoffs,
    ledger: [
      { seq: 2, at: '2026-09-30T09:30:00.000Z', type: 'cabinet', message: '柜位「A2 温湿展柜」读数调整为 20.5℃/50%/150lux（v2→v3），M011 环境签字依据过期作废' },
      { seq: 1, at: '2026-09-30T09:00:00.000Z', type: 'register', message: '核验账初始化：24 件展品、3 个柜位入账' }
    ],
    outbox: [],
    seq: 2,
    writeFailure: false,
    lastWriteError: null
  };
}

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? JSON.parse(saved) as State : buildSeed();
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    isValid: (state) => (so: SignOff) => signOffValid(state.cabinets, state.exhibits, so),
    cabinetOf: (state) => (exhibit: Exhibit) => state.cabinets.find((item) => item.id === exhibit.cabinetId),
    exhibitsInCabinet: (state) => (cabinetId: string) => state.exhibits.filter((item) => item.cabinetId === cabinetId),
    signOffsFor: (state) => (exhibitId: string) => state.signoffs.filter((item) => item.exhibitId === exhibitId),
    discrepanciesFor: (state) => (exhibitId: string) => state.discrepancies.filter((item) => item.exhibitId === exhibitId),
    /** 已作废且尚未重签的签字（同一阶段/角色/类型没有有效替代） */
    voidedPending(): (exhibitId: string) => SignOff[] {
      return (exhibitId: string) => this.signOffsFor(exhibitId).filter((so) => {
        if (this.isValid(so)) return false;
        return !this.signoffs.some((other) => other.exhibitId === exhibitId && other.stage === so.stage && other.role === so.role && other.kind === so.kind && this.isValid(other));
      });
    },
    needsRecheck(): (exhibitId: string) => boolean {
      return (exhibitId: string) => this.voidedPending(exhibitId).length > 0;
    },
    recheckCount(): number {
      return this.exhibits.filter((item) => this.needsRecheck(item.id)).length;
    },
    /** 推进门禁：执行时重新校验，任何一条不满足都停下来重核 */
    advanceBlockers(): (exhibitId: string) => string[] {
      return (exhibitId: string) => {
        const exhibit = this.exhibits.find((item) => item.id === exhibitId);
        if (!exhibit) return ['展品不存在'];
        const reasons: string[] = [];
        const open = this.discrepancies.filter((item) => item.exhibitId === exhibitId && !item.resolved);
        if (open.length) reasons.push(`未解决差异 ${open.length} 条`);
        for (const req of STAGE_REQUIREMENTS[exhibit.stage]) {
          const label = req.kind === 'environment' ? `${req.role}环境签字` : `${req.role}签字`;
          const mine = this.signoffs.filter((so) => so.exhibitId === exhibitId && so.stage === exhibit.stage && so.role === req.role && so.kind === req.kind);
          if (mine.some((so) => this.isValid(so))) continue;
          reasons.push(mine.length ? `${label}已作废，需重核` : `缺${label}`);
        }
        return reasons;
      };
    }
  },
  actions: {
    log(type: LedgerType, message: string) {
      this.seq += 1;
      this.ledger.unshift({ seq: this.seq, at: new Date().toISOString(), type, message });
    },
    enqueue(key: string, label: string) {
      if (this.outbox.some((op) => op.key === key)) return;
      this.outbox.push({ key, label, at: new Date().toISOString() });
    },
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    /** 尝试把出站队列写盘；失败时保留待重试项 */
    flush() {
      if (this.writeFailure) {
        if (this.outbox.length) {
          this.lastWriteError = `写盘失败：${this.outbox.length} 条变更保留在待重试队列`;
          this.log('storage', this.lastWriteError);
        }
        this.persist();
        return false;
      }
      this.outbox = [];
      this.lastWriteError = null;
      this.persist();
      return true;
    },
    /** 恢复后只补未完成核验：队列里只剩未写盘的项，逐条补写 */
    retryFlush() {
      if (this.writeFailure || !this.outbox.length) return;
      const labels = this.outbox.map((op) => op.label);
      this.outbox = [];
      this.lastWriteError = null;
      this.log('storage', `写盘恢复，补完成 ${labels.length} 条未完成核验：${labels.join('；')}`);
      this.persist();
    },
    toggleWriteFailure() {
      this.writeFailure = !this.writeFailure;
      if (this.writeFailure) {
        this.log('storage', '模拟写盘故障开启，后续变更进入待重试队列');
        this.persist();
      } else {
        this.retryFlush();
      }
    },
    /** 签字幂等：同一阶段/角色/类型已有有效签字时，重复提交不生成第二套 */
    sign(exhibitId: string, role: string, kind: SignKind) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      const cabinet = this.cabinets.find((item) => item.id === exhibit.cabinetId);
      if (!cabinet) return;
      const stage = exhibit.stage;
      const renewed = this.signoffs.some((so) => so.exhibitId === exhibitId && so.stage === stage && so.role === role && so.kind === kind && signOffValid(this.cabinets, this.exhibits, so));
      if (renewed) return;
      const id = `${exhibitId}:${stage}:${role}:${kind}@c${cabinet.version}d${exhibit.discrepancyVersion}`;
      if (this.signoffs.some((so) => so.id === id)) return;
      this.signoffs.push({ id, exhibitId, stage, role, kind, cabinetVersion: cabinet.version, discrepancyVersion: exhibit.discrepancyVersion, signedAt: new Date().toISOString() });
      this.log('sign', `${exhibit.code} ${STAGE_LABELS[stage]} · ${role}${kind === 'environment' ? '环境' : ''}签字生效（依据柜位 v${cabinet.version} / 差异 v${exhibit.discrepancyVersion}）`);
      this.enqueue(`sign:${id}`, `${exhibit.code} ${role}签字`);
      this.flush();
    },
    /**
     * 柜位核验提交（乐观并发）：只有期望版本与当前版本一致才生效；
     * 后到者收到版本冲突与受影响展品，整条提交不落地。
     */
    submitCabinetVerification(cabinetId: string, expectedVersion: number, reading: EnvironmentReading, verifier: string): { ok: true } | { ok: false; conflict: ConflictInfo } {
      const cabinet = this.cabinets.find((item) => item.id === cabinetId);
      if (!cabinet) return { ok: false, conflict: { expected: expectedVersion, current: -1, affected: [] } };
      const members = this.exhibits.filter((item) => item.cabinetId === cabinetId);
      if (cabinet.version !== expectedVersion) {
        const affected = members
          .filter((exhibit) => this.signoffs.some((so) => so.exhibitId === exhibit.id && so.kind === 'environment' && !signOffValid(this.cabinets, this.exhibits, so)))
          .map((exhibit) => ({ id: exhibit.id, code: exhibit.code }));
        this.log('conflict', `${verifier} 提交柜位「${cabinet.name}」核验被拒：版本冲突（提交基于 v${expectedVersion}，当前 v${cabinet.version}），受影响展品 ${affected.map((item) => item.code).join('、') || '无'}`);
        this.persist();
        return { ok: false, conflict: { expected: expectedVersion, current: cabinet.version, affected } };
      }
      const changed = reading.temperature !== cabinet.reading.temperature || reading.humidity !== cabinet.reading.humidity || reading.light !== cabinet.reading.light;
      const from = cabinet.version;
      const voided = changed
        ? this.signoffs.filter((so) => so.kind === 'environment' && members.some((exhibit) => exhibit.id === so.exhibitId) && signOffValid(this.cabinets, this.exhibits, so))
        : [];
      if (changed) {
        cabinet.reading = { ...reading };
        cabinet.version += 1;
      }
      // 基于最新读数为布展核验阶段的展品补环境签字（幂等）
      const signed: string[] = [];
      for (const exhibit of members.filter((item) => item.stage === 'install')) {
        const id = `${exhibit.id}:install:布展负责人:environment@c${cabinet.version}d${exhibit.discrepancyVersion}`;
        const already = this.signoffs.some((so) => so.id === id)
          || this.signoffs.some((so) => so.exhibitId === exhibit.id && so.stage === 'install' && so.role === '布展负责人' && so.kind === 'environment' && signOffValid(this.cabinets, this.exhibits, so));
        if (already) continue;
        this.signoffs.push({ id, exhibitId: exhibit.id, stage: 'install', role: '布展负责人', kind: 'environment', cabinetVersion: cabinet.version, discrepancyVersion: exhibit.discrepancyVersion, signedAt: new Date().toISOString() });
        signed.push(exhibit.code);
      }
      const voidedCodes = [...new Set(voided.map((so) => this.exhibits.find((exhibit) => exhibit.id === so.exhibitId)!.code))];
      this.log('cabinet', `${verifier} 提交柜位「${cabinet.name}」核验（v${from}${changed ? `→v${cabinet.version}` : '，读数未变'}）：${reading.temperature}℃/${reading.humidity}%/${reading.light}lux`
        + (voidedCodes.length ? `；作废环境签字 ${voided.length} 条（${voidedCodes.join('、')}）` : '')
        + (signed.length ? `；新签环境签字 ${signed.length} 条（${signed.join('、')}）` : ''));
      this.enqueue(`cabinet:${cabinetId}:v${cabinet.version}`, `柜位${cabinet.name}核验 v${cabinet.version}`);
      this.flush();
      return { ok: true };
    },
    /** 差异变化只让该展品整组签字失效，不波及其他展品 */
    addDiscrepancy(exhibitId: string, title: string, severity: 'minor' | 'major') {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return;
      const id = `d-${Date.now()}`;
      this.discrepancies.push({ id, exhibitId, title, severity, resolved: false });
      this.voidGroup(exhibit, `新增${severity === 'major' ? '重大' : '轻微'}差异「${title}」`);
      this.enqueue(`discrepancy:${id}`, `${exhibit.code} 新增差异`);
      this.flush();
    },
    resolveDiscrepancy(id: string) {
      const item = this.discrepancies.find((entry) => entry.id === id);
      if (!item || item.resolved) return;
      const exhibit = this.exhibits.find((entry) => entry.id === item.exhibitId);
      if (!exhibit) return;
      item.resolved = true;
      this.voidGroup(exhibit, `差异「${item.title}」确认解决`);
      this.enqueue(`resolve:${id}`, `${exhibit.code} 差异解决`);
      this.flush();
    },
    voidGroup(exhibit: Exhibit, reason: string) {
      const voided = this.signoffs.filter((so) => so.exhibitId === exhibit.id && signOffValid(this.cabinets, this.exhibits, so));
      exhibit.discrepancyVersion += 1;
      this.log('discrepancy', `${exhibit.code} ${reason}，整组签字失效 ${voided.length} 条${voided.length ? '，需重签后推进' : ''}`);
    },
    /** 推进在执行时重核；已安装展品只重核签字，现场位置不动 */
    advance(exhibitId: string) {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit || exhibit.stage === 'return') return;
      const blockers = this.advanceBlockers(exhibitId);
      if (blockers.length) {
        this.log('blocked', `${exhibit.code} 推进被拦下重核：${blockers.join('；')}`);
        this.persist();
        return;
      }
      const from = exhibit.stage;
      const to = STAGE_ORDER[STAGE_ORDER.indexOf(from) + 1];
      exhibit.stage = to;
      if (from === 'install') {
        const cabinet = this.cabinets.find((item) => item.id === exhibit.cabinetId)!;
        exhibit.position = `${cabinet.name} · ${exhibit.code}号位`;
        exhibit.installedAt = new Date().toISOString();
      }
      this.log('advance', `${exhibit.code} ${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}${from === 'install' ? `，安装到位：${exhibit.position}` : ''}`);
      this.enqueue(`advance:${exhibitId}:${from}`, `${exhibit.code} 推进到${STAGE_LABELS[to]}`);
      this.flush();
    },
    addExhibit(payload: { code: string; name: string; lender: string; cabinetId: string }) {
      const cabinet = this.cabinets.find((item) => item.id === payload.cabinetId);
      if (!cabinet) return;
      const id = `ex-${Date.now()}`;
      this.exhibits.unshift({ id, ...payload, stage: 'arrival', position: null, installedAt: null, discrepancyVersion: 1 });
      this.log('register', `登记展品 ${payload.code} 进入柜位「${cabinet.name}」，待到场点交`);
      this.enqueue(`exhibit:${id}`, `登记展品 ${payload.code}`);
      this.flush();
    }
  }
});
