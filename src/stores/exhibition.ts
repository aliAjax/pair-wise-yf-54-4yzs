import { defineStore } from 'pinia';
import { isSignatureValid, nextStage, requiredSignatures, signatureKey } from '../services/ledger';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export type SignatureKind = 'handover' | 'environment';
export type SignatureStatus = 'valid' | 'stale';

export interface Cabinet {
  id: string;
  name: string;
  environment: { temperature: number; humidity: number; light: number };
  version: number;
}

export interface Signature {
  id: string;
  exhibitId: string;
  stage: Stage;
  role: string;
  kind: SignatureKind;
  status: SignatureStatus;
  /** 环境签字快照的柜位版本；柜位版本变化后签字作废。 */
  cabinetVersion?: number;
  createdAt: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  cabinetId: string;
  stage: Stage;
  status: CheckStatus;
}

export interface Discrepancy {
  id: string;
  exhibitId: string;
  title: string;
  severity: 'minor' | 'major';
  resolved: boolean;
}

export type PendingOpType =
  | 'sign'
  | 'environment-submit'
  | 'update-readings'
  | 'add-discrepancy'
  | 'resolve-discrepancy'
  | 'advance'
  | 'set-condition'
  | 'add-exhibit';

export interface PendingOp {
  id: string;
  /** 幂等键：重复提交不会入队第二笔，恢复时也据此判重。 */
  key: string;
  type: PendingOpType;
  payload: Record<string, unknown>;
  status: 'pending' | 'failed';
  error?: string;
  createdAt: number;
}

export type ActionResult =
  | { ok: true;[key: string]: unknown }
  | {
    ok: false;
    reason: 'stale_signatures' | 'unresolved_discrepancy' | 'version_conflict' | 'write_failed' | 'not_found';
    message: string;
    [key: string]: unknown;
  };

interface State {
  cabinets: Cabinet[];
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  signatures: Signature[];
  pendingOps: PendingOp[];
  /** 写盘失败开关：打开后所有提交落不进盘，只保留待重试项。 */
  writeFailure: boolean;
}

const CABINET_A2: Cabinet = { id: 'A2', name: 'A2 温湿展柜', environment: { temperature: 22, humidity: 52, light: 180 }, version: 1 };
const CABINET_B1: Cabinet = { id: 'B1', name: 'B1 开放展区', environment: { temperature: 20, humidity: 50, light: 150 }, version: 1 };

function buildSeed(): State {
  const exhibits: Exhibit[] = Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    cabinetId: index % 3 === 0 ? 'A2' : 'B1',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending'
  }));
  const signatures: Signature[] = [];
  exhibits.forEach((exhibit, index) => {
    const roles = index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [];
    for (const role of roles) {
      signatures.push({
        id: `sig-${exhibit.id}-${role}`,
        exhibitId: exhibit.id,
        stage: exhibit.stage,
        role,
        kind: 'handover',
        status: 'valid',
        createdAt: 0
      });
    }
  });
  return {
    cabinets: [CABINET_A2, CABINET_B1],
    exhibits,
    discrepancies: [
      { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
      { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
    ],
    signatures,
    pendingOps: [],
    writeFailure: false
  };
}

/** 旧版本地数据迁移：补柜位、把 signed 展开成签字记录。 */
function migrate(raw: any): State {
  if (raw && Array.isArray(raw.cabinets) && Array.isArray(raw.signatures)) {
    return { pendingOps: [], writeFailure: false, ...raw };
  }
  const seed = buildSeed();
  if (!raw || !Array.isArray(raw.exhibits)) return seed;
  const cabinetById = new Map<string, Cabinet>();
  for (const exhibit of raw.exhibits as any[]) {
    const name = typeof exhibit.hall === 'string' ? exhibit.hall : 'B1 开放展区';
    const id = name.includes('A2') ? 'A2' : 'B1';
    if (!cabinetById.has(id)) {
      const base = id === 'A2' ? CABINET_A2 : CABINET_B1;
      cabinetById.set(id, { ...base, name, environment: { ...base.environment }, version: 1 });
    }
  }
  const exhibits: Exhibit[] = raw.exhibits.map((e: any) => ({
    id: e.id,
    code: e.code,
    name: e.name,
    lender: e.lender,
    cabinetId: (typeof e.hall === 'string' && e.hall.includes('A2')) ? 'A2' : 'B1',
    stage: e.stage ?? 'arrival',
    status: e.status ?? 'pending'
  }));
  const signatures: Signature[] = [];
  for (const e of raw.exhibits as any[]) {
    for (const role of e.signed ?? []) {
      signatures.push({
        id: `sig-${e.id}-${role}`,
        exhibitId: e.id,
        stage: e.stage ?? 'arrival',
        role,
        kind: 'handover',
        status: 'valid',
        createdAt: 0
      });
    }
  }
  return {
    cabinets: [...cabinetById.values()],
    exhibits,
    discrepancies: Array.isArray(raw.discrepancies) ? raw.discrepancies : seed.discrepancies,
    signatures,
    pendingOps: [],
    writeFailure: false
  };
}

function load(): State {
  try {
    const saved = localStorage.getItem('yf54-exhibition-state');
    if (saved) return migrate(JSON.parse(saved));
  } catch {
    /* 损坏的本地数据直接回退种子 */
  }
  return buildSeed();
}

let opSeq = 0;
function newOpId() {
  opSeq += 1;
  return `op-${Date.now()}-${opSeq}`;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: (): State => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    queued: (state) => state.pendingOps.length,
    stageCounts: (state) => ({
      arrival: state.exhibits.filter((item) => item.stage === 'arrival').length,
      install: state.exhibits.filter((item) => item.stage === 'install').length,
      return: state.exhibits.filter((item) => item.stage === 'return').length
    }),
    cabinetMap: (state) => new Map(state.cabinets.map((cabinet) => [cabinet.id, cabinet]))
  },
  actions: {
    // ---------- 基础查询 ----------
    cabinetFor(exhibitId: string): Cabinet | undefined {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      return exhibit ? this.cabinets.find((cabinet) => cabinet.id === exhibit.cabinetId) : undefined;
    },
    exhibitsInCabinet(cabinetId: string): Exhibit[] {
      return this.exhibits.filter((item) => item.cabinetId === cabinetId);
    },
    signaturesFor(exhibitId: string): Signature[] {
      return this.signatures.filter((item) => item.exhibitId === exhibitId);
    },
    /** 某展品某类签字当前是否有效（环境签字还要比对柜位版本）。 */
    hasValidSignature(exhibitId: string, role: string, kind: SignatureKind): boolean {
      const cabinet = this.cabinetFor(exhibitId);
      return this.signatures.some((sig) =>
        sig.exhibitId === exhibitId &&
        sig.role === role &&
        sig.kind === kind &&
        isSignatureValid(sig, cabinet)
      );
    },
    /** 当前阶段推进所缺的签字（过期或缺失都算缺）。 */
    missingRoles(exhibitId: string): string[] {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return [];
      const cabinet = this.cabinetFor(exhibitId);
      return requiredSignatures(exhibit.stage)
        .filter((req) => !this.signatures.some((sig) =>
          sig.exhibitId === exhibitId &&
          sig.role === req.role &&
          sig.kind === req.kind &&
          isSignatureValid(sig, cabinet)))
        .map((req) => req.role);
    },

    // ---------- 作废规则 ----------
    /** 柜位数据变化：作废该柜位内所有依赖读数的环境签字。 */
    invalidateEnvironmentForCabinet(cabinetId: string) {
      const ids = new Set(this.exhibits.filter((item) => item.cabinetId === cabinetId).map((item) => item.id));
      for (const sig of this.signatures) {
        if (sig.kind === 'environment' && ids.has(sig.exhibitId) && sig.status === 'valid') {
          sig.status = 'stale';
        }
      }
    },
    /** 差异变化：只作废该展品的整组签字，不影响同柜位其他展品。 */
    invalidateExhibitSignatures(exhibitId: string) {
      for (const sig of this.signatures.filter((item) => item.exhibitId === exhibitId)) {
        sig.status = 'stale';
      }
    },

    // ---------- 写盘通道（失败保留待重试项） ----------
    persist() {
      localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state));
    },
    /** 提交一笔写操作：写盘失败则保留为待重试项，恢复后只补未完成部分。 */
    commit(op: { type: PendingOpType; key: string; payload: Record<string, unknown> }): ActionResult {
      if (this.writeFailure) {
        if (!this.pendingOps.some((item) => item.key === op.key)) {
          this.pendingOps.push({ id: newOpId(), status: 'pending', createdAt: Date.now(), ...op });
        }
        return { ok: false, reason: 'write_failed', message: '写盘失败：已保留待重试项，恢复后自动补写，不会重复签字' };
      }
      try {
        this.apply(op.type, op.payload);
        this.persist();
        return { ok: true };
      } catch (error) {
        if (!this.pendingOps.some((item) => item.key === op.key)) {
          this.pendingOps.push({ id: newOpId(), status: 'failed', error: String(error), createdAt: Date.now(), ...op });
        }
        return { ok: false, reason: 'write_failed', message: '写盘失败：已保留待重试项' };
      }
    },
    /** 重放一笔操作（幂等：已满足的不再重复生成签字/数据）。 */
    apply(type: PendingOpType, payload: Record<string, unknown>) {
      switch (type) {
        case 'sign': {
          const exhibitId = String(payload.exhibitId);
          const role = String(payload.role);
          const kind = String(payload.kind) as SignatureKind;
          const exhibit = this.exhibits.find((item) => item.id === exhibitId);
          if (!exhibit) return;
          const stage = String(payload.stage ?? exhibit.stage) as Stage;
          const key = signatureKey(exhibitId, stage, role, kind);
          // 幂等：同展品/阶段/角色/核验类已有有效签字，不再生成第二套。
          if (this.signatures.some((sig) => signatureKey(sig.exhibitId, sig.stage, sig.role, sig.kind) === key && sig.status === 'valid')) return;
          this.signatures.push({
            id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            exhibitId,
            stage,
            role,
            kind,
            status: 'valid',
            cabinetVersion: kind === 'environment' ? this.cabinetFor(exhibitId)?.version : undefined,
            createdAt: Date.now()
          });
          return;
        }
        case 'environment-submit': {
          const cabinetId = String(payload.cabinetId);
          const cabinet = this.cabinets.find((item) => item.id === cabinetId);
          if (!cabinet) return;
          const baseVersion = Number(payload.baseVersion ?? cabinet.version);
          if (cabinet.version > baseVersion) return; // 已被他人提交，重放不覆盖
          cabinet.environment = {
            temperature: Number((payload.readings as any).temperature),
            humidity: Number((payload.readings as any).humidity),
            light: Number((payload.readings as any).light)
          };
          cabinet.version += 1;
          const role = String(payload.role ?? '布展负责人');
          for (const exhibit of this.exhibits.filter((item) => item.cabinetId === cabinetId)) {
            // 清掉该展品过期的环境签字，再在新版本上补签。
            this.signatures = this.signatures.filter((sig) =>
              !(sig.exhibitId === exhibit.id && sig.kind === 'environment' && sig.status === 'stale'));
            const key = signatureKey(exhibit.id, exhibit.stage, role, 'environment');
            const existing = this.signatures.find((sig) => signatureKey(sig.exhibitId, sig.stage, sig.role, sig.kind) === key);
            if (existing) {
              existing.status = 'valid';
              existing.cabinetVersion = cabinet.version;
            } else {
              this.signatures.push({
                id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                exhibitId: exhibit.id,
                stage: exhibit.stage,
                role,
                kind: 'environment',
                status: 'valid',
                cabinetVersion: cabinet.version,
                createdAt: Date.now()
              });
            }
          }
          return;
        }
        case 'update-readings': {
          const cabinetId = String(payload.cabinetId);
          const cabinet = this.cabinets.find((item) => item.id === cabinetId);
          if (!cabinet) return;
          const baseVersion = Number(payload.baseVersion ?? cabinet.version);
          if (cabinet.version > baseVersion) return;
          cabinet.environment = {
            temperature: Number((payload.readings as any).temperature),
            humidity: Number((payload.readings as any).humidity),
            light: Number((payload.readings as any).light)
          };
          cabinet.version += 1;
          this.invalidateEnvironmentForCabinet(cabinetId);
          return;
        }
        case 'add-discrepancy': {
          const exhibitId = String(payload.exhibitId);
          const title = String(payload.title);
          if (this.discrepancies.some((item) => item.exhibitId === exhibitId && item.title === title)) return;
          this.discrepancies.push({
            id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            exhibitId,
            title,
            severity: (payload.severity as 'minor' | 'major') ?? 'minor',
            resolved: false
          });
          // 单件差异变化：只让该展品整组签字失效。
          this.invalidateExhibitSignatures(exhibitId);
          return;
        }
        case 'resolve-discrepancy': {
          const discrepancy = this.discrepancies.find((item) => item.id === String(payload.id));
          if (!discrepancy || discrepancy.resolved) return;
          discrepancy.resolved = true;
          this.invalidateExhibitSignatures(discrepancy.exhibitId);
          return;
        }
        case 'advance': {
          const exhibit = this.exhibits.find((item) => item.id === String(payload.exhibitId));
          if (!exhibit || exhibit.stage !== payload.from) return; // 已推进过，重放不重复
          exhibit.stage = payload.target as Stage;
          return;
        }
        case 'set-condition': {
          const exhibit = this.exhibits.find((item) => item.id === String(payload.exhibitId));
          if (!exhibit) return;
          exhibit.status = payload.status as CheckStatus;
          return;
        }
        case 'add-exhibit': {
          const code = String(payload.code);
          if (this.exhibits.some((item) => item.code === code)) return;
          this.exhibits.unshift({
            id: `ex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            code,
            name: String(payload.name),
            lender: String(payload.lender),
            cabinetId: String(payload.cabinetId ?? 'B1'),
            stage: 'arrival',
            status: 'pending'
          });
          return;
        }
      }
    },
    /** 判断待重试项是否已被满足（只补未完成核验）。 */
    isSatisfied(op: PendingOp): boolean {
      switch (op.type) {
        case 'sign': {
          const exhibitId = String(op.payload.exhibitId);
          const role = String(op.payload.role);
          const kind = String(op.payload.kind) as SignatureKind;
          const stage = String(op.payload.stage ?? 'arrival') as Stage;
          const key = signatureKey(exhibitId, stage, role, kind);
          return this.signatures.some((sig) => signatureKey(sig.exhibitId, sig.stage, sig.role, sig.kind) === key && sig.status === 'valid');
        }
        case 'environment-submit':
        case 'update-readings': {
          const cabinet = this.cabinets.find((item) => item.id === String(op.payload.cabinetId));
          return !!cabinet && cabinet.version > Number(op.payload.baseVersion ?? cabinet.version);
        }
        case 'add-discrepancy':
          return this.discrepancies.some((item) => item.exhibitId === String(op.payload.exhibitId) && item.title === String(op.payload.title));
        case 'resolve-discrepancy': {
          const discrepancy = this.discrepancies.find((item) => item.id === String(op.payload.id));
          return !!discrepancy && discrepancy.resolved;
        }
        case 'advance': {
          const exhibit = this.exhibits.find((item) => item.id === String(op.payload.exhibitId));
          return !!exhibit && exhibit.stage === op.payload.target;
        }
        case 'set-condition': {
          const exhibit = this.exhibits.find((item) => item.id === String(op.payload.exhibitId));
          return !!exhibit && exhibit.status === op.payload.status;
        }
        case 'add-exhibit':
          return this.exhibits.some((item) => item.code === String(op.payload.code));
      }
    },
    /** 恢复后补写：只补未完成的核验，已满足的直接丢弃。 */
    retryPending(): { ok: true; applied: number; skipped: number; pending: number } {
      let applied = 0;
      let skipped = 0;
      for (const op of [...this.pendingOps]) {
        if (this.isSatisfied(op)) {
          this.pendingOps = this.pendingOps.filter((item) => item.id !== op.id);
          skipped += 1;
          continue;
        }
        if (this.writeFailure) continue;
        try {
          this.apply(op.type, op.payload);
          this.persist();
          this.pendingOps = this.pendingOps.filter((item) => item.id !== op.id);
          applied += 1;
        } catch (error) {
          op.status = 'failed';
          op.error = String(error);
        }
      }
      return { ok: true, applied, skipped, pending: this.pendingOps.length };
    },
    /** 兼容旧界面命名。 */
    syncQueue() {
      return this.retryPending();
    },
    setWriteFailure(enabled: boolean) {
      this.writeFailure = enabled;
    },

    // ---------- 业务动作 ----------
    /** 签字（默认到场交接签字）：幂等，重复提交不生成第二套。 */
    sign(exhibitId: string, role: string, kind: SignatureKind = 'handover'): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return { ok: false, reason: 'not_found', message: '展品不存在' };
      const key = signatureKey(exhibitId, exhibit.stage, role, kind);
      if (this.signatures.some((sig) => signatureKey(sig.exhibitId, sig.stage, sig.role, sig.kind) === key && sig.status === 'valid')) {
        return { ok: true, idempotent: true };
      }
      return this.commit({ type: 'sign', key, payload: { exhibitId, role, kind, stage: exhibit.stage } });
    },
    /** 单件展品环境签字（快照当前柜位版本）。 */
    signEnvironment(exhibitId: string, role = '布展负责人'): ActionResult {
      return this.sign(exhibitId, role, 'environment');
    },
    /**
     * 提交柜位环境核验（两名负责人同时提交同一柜位）。
     * 后到者携带的 baseVersion 落后于柜位当前版本时返回版本冲突，
     * 并给出受影响展品清单；先到者正常落盘。
     */
    submitEnvironmentCheck(
      cabinetId: string,
      readings: { temperature: number; humidity: number; light: number },
      role = '布展负责人',
      baseVersion?: number
    ): ActionResult {
      const cabinet = this.cabinets.find((item) => item.id === cabinetId);
      if (!cabinet) return { ok: false, reason: 'not_found', message: '柜位不存在' };
      if (baseVersion != null && baseVersion !== cabinet.version) {
        return {
          ok: false,
          reason: 'version_conflict',
          message: `柜位「${cabinet.name}」已被先到的负责人核验（当前版本 v${cabinet.version}），请刷新后对受影响展品重新核验`,
          currentVersion: cabinet.version,
          affectedExhibits: this.exhibits.filter((item) => item.cabinetId === cabinetId).map((item) => item.id)
        };
      }
      const normalized = {
        temperature: Number.isFinite(Number(readings?.temperature)) ? Number(readings.temperature) : cabinet.environment.temperature,
        humidity: Number.isFinite(Number(readings?.humidity)) ? Number(readings.humidity) : cabinet.environment.humidity,
        light: Number.isFinite(Number(readings?.light)) ? Number(readings.light) : cabinet.environment.light
      };
      const key = `environment-submit:${cabinetId}:${baseVersion ?? cabinet.version}`;
      return this.commit({ type: 'environment-submit', key, payload: { cabinetId, readings: normalized, role, baseVersion: baseVersion ?? cabinet.version } });
    },
    /** 仅保存柜位读数：读数变化作废依赖它的环境签字。 */
    updateCabinetReadings(cabinetId: string, readings: { temperature: number; humidity: number; light: number }): ActionResult {
      const cabinet = this.cabinets.find((item) => item.id === cabinetId);
      if (!cabinet) return { ok: false, reason: 'not_found', message: '柜位不存在' };
      const normalized = {
        temperature: Number.isFinite(Number(readings?.temperature)) ? Number(readings.temperature) : cabinet.environment.temperature,
        humidity: Number.isFinite(Number(readings?.humidity)) ? Number(readings.humidity) : cabinet.environment.humidity,
        light: Number.isFinite(Number(readings?.light)) ? Number(readings.light) : cabinet.environment.light
      };
      const key = `update-readings:${cabinetId}:${cabinet.version}`;
      return this.commit({ type: 'update-readings', key, payload: { cabinetId, readings: normalized, baseVersion: cabinet.version } });
    },
    addDiscrepancy(exhibitId: string, title: string, severity: 'minor' | 'major' = 'minor'): ActionResult {
      if (!this.exhibits.some((item) => item.id === exhibitId)) return { ok: false, reason: 'not_found', message: '展品不存在' };
      const key = `add-discrepancy:${exhibitId}:${title}`;
      return this.commit({ type: 'add-discrepancy', key, payload: { exhibitId, title, severity } });
    },
    resolveDiscrepancy(id: string): ActionResult {
      const discrepancy = this.discrepancies.find((item) => item.id === id);
      if (!discrepancy) return { ok: false, reason: 'not_found', message: '差异项不存在' };
      const key = `resolve-discrepancy:${id}`;
      return this.commit({ type: 'resolve-discrepancy', key, payload: { id } });
    },
    setCondition(exhibitId: string, status: CheckStatus): ActionResult {
      if (!this.exhibits.some((item) => item.id === exhibitId)) return { ok: false, reason: 'not_found', message: '展品不存在' };
      const key = `set-condition:${exhibitId}:${status}`;
      return this.commit({ type: 'set-condition', key, payload: { exhibitId, status } });
    },
    addExhibit(payload: { code: string; name: string; lender: string; cabinetId: string }): ActionResult {
      const key = `add-exhibit:${payload.code}`;
      return this.commit({ type: 'add-exhibit', key, payload });
    },
    /** 推进：未执行的推进停下来重核；已安装展品保持现场位置（只向前、不回退）。 */
    advance(exhibitId: string): ActionResult {
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (!exhibit) return { ok: false, reason: 'not_found', message: '展品不存在' };
      if (this.discrepancies.some((item) => item.exhibitId === exhibitId && !item.resolved)) {
        return { ok: false, reason: 'unresolved_discrepancy', message: '存在未解决差异，不能推进' };
      }
      const missing = this.missingRoles(exhibitId);
      if (missing.length) {
        return {
          ok: false,
          reason: 'stale_signatures',
          message: `签字已过期或缺失（${missing.join('、')}），请重新核验后再推进`,
          missing
        };
      }
      const target = nextStage(exhibit.stage);
      const key = `advance:${exhibitId}:${exhibit.stage}`;
      return this.commit({ type: 'advance', key, payload: { exhibitId, from: exhibit.stage, target } });
    }
  }
});
