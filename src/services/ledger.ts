import type { Cabinet, Exhibit, Signature, Stage, SignatureKind } from '../stores/exhibition';

/**
 * 核验账领域规则：签字有效性、阶段要求、柜位依赖。
 * 纯函数，便于在 store 与界面两侧复用同一套判定。
 */

/** 签字的幂等键：同一展品、同一阶段、同一角色、同一类核验只允许一套签字。 */
export function signatureKey(exhibitId: string, stage: Stage, role: string, kind: SignatureKind): string {
  return `${exhibitId}|${stage}|${role}|${kind}`;
}

/**
 * 判断签字当前是否有效。
 * - 已被标记 stale 的签字一律无效；
 * - 环境签字依赖柜位读数，签字快照的柜位版本必须等于当前柜位版本，
 *   柜位读数一变，快照过期，签字即作废。
 */
export function isSignatureValid(sig: Signature | undefined, cabinet: Cabinet | undefined): boolean {
  if (!sig || sig.status !== 'valid') return false;
  if (sig.kind === 'environment') {
    return sig.cabinetVersion != null && cabinet != null && sig.cabinetVersion === cabinet.version;
  }
  return true;
}

/** 某阶段推进前必须齐备的签字（按阶段、角色、核验类）。 */
export function requiredSignatures(stage: Stage): { kind: SignatureKind; role: string }[] {
  if (stage === 'arrival') {
    return [
      { kind: 'handover', role: '保管员' },
      { kind: 'handover', role: '借展方' }
    ];
  }
  if (stage === 'install') {
    return [{ kind: 'environment', role: '布展负责人' }];
  }
  return [];
}

/** 柜位内受读数/版本影响的展品清单（后到者看到的受影响展品）。 */
export function exhibitsInCabinet(cabinetId: string, exhibits: Exhibit[]): Exhibit[] {
  return exhibits.filter((item) => item.cabinetId === cabinetId);
}

export function exhibitIdsInCabinet(cabinetId: string, exhibits: Exhibit[]): string[] {
  return exhibitsInCabinet(cabinetId, exhibits).map((item) => item.id);
}

/** 阶段顺序，用于判断推进方向（已安装展品保持现场位置，只向前推进）。 */
export const stageOrder: Stage[] = ['arrival', 'install', 'return'];

export function nextStage(stage: Stage): Stage {
  const index = stageOrder.indexOf(stage);
  return stageOrder[Math.min(index + 1, stageOrder.length - 1)];
}
