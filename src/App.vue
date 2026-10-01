<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import {
  useExhibitionStore,
  STAGE_LABELS,
  STAGE_REQUIREMENTS,
  type Cabinet,
  type ConflictInfo,
  type Exhibit,
  type LedgerType,
  type SignKind
} from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'cabinets' | 'discrepancy' | 'ledger'>('checkin');
const apiLabel = computed(() => String(api.defaults.baseURL));

// 登记新展品
const dialog = ref(false);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), cabinetId: z.string().min(1) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [cabinetId] = defineField('cabinetId');
const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });

// 展品详情
const selected = ref<Exhibit | null>(null);
const selectedBlockers = computed(() => (selected.value ? store.advanceBlockers(selected.value.id) : []));
const selectedSignOffs = computed(() => (selected.value ? store.signOffsFor(selected.value.id) : []));
const selectedDiscrepancies = computed(() => (selected.value ? store.discrepanciesFor(selected.value.id) : []));

// 柜位核验（打开时捕获版本，提交时做乐观并发校验）
const verifyDialog = ref(false);
const verifyCabinetId = ref('');
const verifyBaseVersion = ref(0);
const verifyForm = reactive({ temperature: 0, humidity: 0, light: 0, verifier: '布展负责人·王' });
const verifyConflict = ref<ConflictInfo | null>(null);
const verifyCabinet = computed(() => store.cabinets.find((item) => item.id === verifyCabinetId.value) ?? null);

function openVerify(cabinet: Cabinet) {
  verifyCabinetId.value = cabinet.id;
  verifyBaseVersion.value = cabinet.version;
  Object.assign(verifyForm, { temperature: cabinet.reading.temperature, humidity: cabinet.reading.humidity, light: cabinet.reading.light });
  verifyConflict.value = null;
  verifyDialog.value = true;
}
function submitVerify() {
  const result = store.submitCabinetVerification(
    verifyCabinetId.value,
    verifyBaseVersion.value,
    { temperature: Number(verifyForm.temperature), humidity: Number(verifyForm.humidity), light: Number(verifyForm.light) },
    verifyForm.verifier
  );
  if (result.ok) verifyDialog.value = false;
  else verifyConflict.value = result.conflict;
}
function simulateRival(cabinet: Cabinet) {
  store.submitCabinetVerification(cabinet.id, cabinet.version, { ...cabinet.reading, temperature: Math.round((cabinet.reading.temperature + 0.5) * 10) / 10 }, '布展负责人·李');
}

// 新增差异
const discrepancyForm = reactive({ exhibitId: '', title: '', severity: 'minor' as 'minor' | 'major' });
function submitDiscrepancy() {
  if (!discrepancyForm.exhibitId || discrepancyForm.title.trim().length < 2) return;
  store.addDiscrepancy(discrepancyForm.exhibitId, discrepancyForm.title.trim(), discrepancyForm.severity);
  discrepancyForm.title = '';
}

const LEDGER_META: Record<LedgerType, { color: string; label: string }> = {
  sign: { color: 'green', label: '签字' },
  cabinet: { color: 'blue', label: '柜位核验' },
  conflict: { color: 'red', label: '版本冲突' },
  discrepancy: { color: 'orange', label: '差异' },
  advance: { color: 'purple', label: '推进' },
  blocked: { color: 'red', label: '拦下重核' },
  storage: { color: 'grey-darken-1', label: '写盘' },
  register: { color: 'teal', label: '登记' }
};

function requirementStatus(exhibit: Exhibit, req: { role: string; kind: SignKind }): 'valid' | 'voided' | 'missing' {
  const mine = store.signoffs.filter((so) => so.exhibitId === exhibit.id && so.stage === exhibit.stage && so.role === req.role && so.kind === req.kind);
  if (mine.some((so) => store.isValid(so))) return 'valid';
  return mine.length ? 'voided' : 'missing';
}
function requirementLabel(req: { role: string; kind: SignKind }) {
  return req.kind === 'environment' ? `${req.role} · 环境签字` : `${req.role} · 点交签字`;
}
function cabinetEnvStats(id: string) {
  const members = store.exhibitsInCabinet(id);
  const envs = store.signoffs.filter((so) => so.kind === 'environment' && members.some((exhibit) => exhibit.id === so.exhibitId));
  const valid = envs.filter((so) => store.isValid(so)).length;
  return { valid, voided: envs.length - valid };
}
function exhibitCode(id: string) {
  return store.exhibits.find((item) => item.id === id)?.code ?? id;
}
function formatTime(at: string) {
  return new Date(at).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-2" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-chip v-if="store.outbox.length" class="mr-2" color="orange" theme="dark">待重试 {{ store.outbox.length }}</v-chip>
      <v-btn v-if="store.outbox.length && !store.writeFailure" class="mr-2" size="small" variant="tonal" @click="store.retryFlush()">重试写盘</v-btn>
      <v-switch
        :model-value="store.writeFailure"
        class="mr-2 mt-5"
        color="orange"
        density="compact"
        hide-details
        label="模拟写盘故障"
        @update:model-value="store.toggleWriteFailure()"
      />
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-4">
          网络不可用时核验不会丢失：变更先落本地账，恢复后补写。接口地址 {{ apiLabel }}
        </v-alert>
        <v-alert v-if="store.lastWriteError" color="red-lighten-4" icon="mdi-alert-circle-outline" class="mb-4">
          <div class="d-flex align-center flex-wrap">
            <span>{{ store.lastWriteError }}：{{ store.outbox.map((op) => op.label).join('；') }}</span>
            <v-btn class="ml-4" size="small" color="red" :disabled="store.writeFailure" @click="store.retryFlush()">恢复后补写未完成核验</v-btn>
          </div>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">布展核验中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="6" md="3"><v-card><v-card-text><div class="metric-label">待重核展品</div><div class="metric warn">{{ store.recheckCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="cabinets">{{ $t('cabinets') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
            <v-tab value="ledger">{{ $t('ledger') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ store.cabinetOf(item)?.name }} · {{ STAGE_LABELS[item.stage] }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip v-if="item.position" size="small" class="mr-1" color="teal" variant="tonal">已安装 · 位置保持</v-chip>
                      <v-chip v-if="store.needsRecheck(item.id)" size="small" color="red">待重核</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <v-window-item value="cabinets">
              <v-row class="pa-4">
                <v-col v-for="cabinet in store.cabinets" :key="cabinet.id" cols="12" md="4">
                  <v-card variant="outlined">
                    <v-card-title class="d-flex align-center">
                      {{ cabinet.name }}
                      <v-chip class="ml-2" size="small" color="deep-purple" variant="tonal">v{{ cabinet.version }}</v-chip>
                    </v-card-title>
                    <v-card-text>
                      <div class="mb-2">温湿度 / 照度：<b>{{ cabinet.reading.temperature }}℃ · {{ cabinet.reading.humidity }}% · {{ cabinet.reading.light }} lux</b>（柜内展品共用）</div>
                      <div class="mb-2">
                        环境签字：有效 <b class="text-green">{{ cabinetEnvStats(cabinet.id).valid }}</b> / 已作废 <b class="text-red">{{ cabinetEnvStats(cabinet.id).voided }}</b>
                      </div>
                      <div class="mb-3">
                        <v-chip
                          v-for="exhibit in store.exhibitsInCabinet(cabinet.id)"
                          :key="exhibit.id"
                          size="small"
                          class="mr-1 mb-1"
                          :color="store.needsRecheck(exhibit.id) ? 'red' : 'grey'"
                          variant="tonal"
                        >{{ exhibit.code }}</v-chip>
                      </div>
                      <v-btn color="deep-purple" size="small" @click="openVerify(cabinet)">提交柜位核验</v-btn>
                      <v-btn size="small" variant="text" title="模拟另一名负责人基于同一版本并发提交" @click="simulateRival(cabinet)">另一负责人提交</v-btn>
                    </v-card-text>
                  </v-card>
                </v-col>
              </v-row>
            </v-window-item>

            <v-window-item value="discrepancy">
              <v-form class="d-flex align-start pa-4 ga-3 flex-wrap" @submit.prevent="submitDiscrepancy">
                <v-select
                  v-model="discrepancyForm.exhibitId"
                  :items="store.exhibits.map((item) => ({ value: item.id, title: `${item.code} · ${item.name}` }))"
                  label="展品"
                  density="compact"
                  hide-details
                  style="max-width: 260px"
                />
                <v-text-field v-model="discrepancyForm.title" label="差异描述" density="compact" hide-details style="max-width: 320px" />
                <v-select
                  v-model="discrepancyForm.severity"
                  :items="[{ value: 'minor', title: '轻微差异' }, { value: 'major', title: '重大差异' }]"
                  label="级别"
                  density="compact"
                  hide-details
                  style="max-width: 140px"
                />
                <v-btn type="submit" color="orange" :disabled="!discrepancyForm.exhibitId || discrepancyForm.title.trim().length < 2">登记差异</v-btn>
              </v-form>
              <v-alert type="info" variant="tonal" density="compact" class="mx-4">差异新增或确认解决只会让该展品整组签字失效，其他展品签字照旧。</v-alert>
              <v-list>
                <v-list-item v-for="item in store.discrepancies" :key="item.id">
                  <v-list-item-title>{{ item.title }}</v-list-item-title>
                  <v-list-item-subtitle>展品 {{ exhibitCode(item.exhibitId) }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle>
                  <template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template>
                </v-list-item>
              </v-list>
            </v-window-item>

            <v-window-item value="ledger">
              <v-list density="compact" class="ledger-list">
                <v-list-item v-for="entry in store.ledger" :key="entry.seq">
                  <template #prepend><v-chip size="small" :color="LEDGER_META[entry.type].color" variant="tonal" class="mr-3">{{ LEDGER_META[entry.type].label }}</v-chip></template>
                  <v-list-item-title class="text-wrap">{{ entry.message }}</v-list-item-title>
                  <v-list-item-subtitle>#{{ entry.seq }} · {{ formatTime(entry.at) }}</v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text>
              <v-form @submit.prevent="submit">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-select v-model="cabinetId" :items="store.cabinets.map((item) => ({ value: item.id, title: item.name }))" label="柜位" :error-messages="errors.cabinetId" />
                <v-btn type="submit" color="deep-purple" block>写入核验账</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="720" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <div class="mb-3">
                <v-chip size="small" color="deep-purple" variant="tonal" class="mr-2">{{ STAGE_LABELS[selected.stage] }}</v-chip>
                <v-chip v-if="store.needsRecheck(selected.id)" size="small" color="red">存在已作废签字，推进前需重核</v-chip>
              </div>
              <v-alert v-if="selected.position" color="teal-lighten-5" density="compact" class="mb-4">
                现场位置：{{ selected.position }}（已安装，核验作废不清除位置）
              </v-alert>

              <h4 class="mb-2">当前阶段所需签字</h4>
              <v-list density="compact" class="mb-4">
                <v-list-item v-for="req in STAGE_REQUIREMENTS[selected.stage]" :key="req.role + req.kind">
                  <v-list-item-title>{{ requirementLabel(req) }}</v-list-item-title>
                  <template #append>
                    <v-chip
                      size="small"
                      class="mr-2"
                      :color="requirementStatus(selected, req) === 'valid' ? 'green' : requirementStatus(selected, req) === 'voided' ? 'red' : 'grey'"
                    >{{ { valid: '有效', voided: '已作废待重签', missing: '未签' }[requirementStatus(selected, req)] }}</v-chip>
                    <v-btn size="small" :disabled="requirementStatus(selected, req) === 'valid'" @click="store.sign(selected.id, req.role, req.kind)">
                      {{ requirementStatus(selected, req) === 'voided' ? '重签' : '签字' }}
                    </v-btn>
                  </template>
                </v-list-item>
              </v-list>

              <h4 class="mb-2">签字记录（含历史）</h4>
              <v-table density="compact" class="mb-4">
                <thead><tr><th>阶段</th><th>签字</th><th>依据版本</th><th>状态</th></tr></thead>
                <tbody>
                  <tr v-for="so in selectedSignOffs" :key="so.id">
                    <td>{{ STAGE_LABELS[so.stage] }}</td>
                    <td>{{ so.role }}{{ so.kind === 'environment' ? ' · 环境' : '' }}</td>
                    <td>柜位 v{{ so.cabinetVersion }} / 差异 v{{ so.discrepancyVersion }}</td>
                    <td><v-chip size="small" :color="store.isValid(so) ? 'green' : 'red'" variant="tonal">{{ store.isValid(so) ? '有效' : '已作废' }}</v-chip></td>
                  </tr>
                  <tr v-if="!selectedSignOffs.length"><td colspan="4" class="text-grey">暂无签字</td></tr>
                </tbody>
              </v-table>

              <template v-if="selectedDiscrepancies.length">
                <h4 class="mb-2">差异项</h4>
                <v-list density="compact" class="mb-4">
                  <v-list-item v-for="item in selectedDiscrepancies" :key="item.id">
                    <v-list-item-title>{{ item.title }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.severity === 'major' ? '重大差异' : '轻微差异' }} · {{ item.resolved ? '已解决' : '未解决' }}</v-list-item-subtitle>
                  </v-list-item>
                </v-list>
              </template>

              <v-divider class="mb-3" />
              <v-alert v-if="selectedBlockers.length" color="red-lighten-4" density="compact" class="mb-3">
                推进被拦下重核：{{ selectedBlockers.join('；') }}
              </v-alert>
              <v-btn color="deep-purple" :disabled="selected.stage === 'return' || selectedBlockers.length > 0" @click="store.advance(selected.id)">
                {{ selected.stage === 'return' ? '已到最终阶段' : '推进到下一阶段' }}
              </v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog v-model="verifyDialog" max-width="560">
          <v-card v-if="verifyCabinet" :title="`柜位核验 · ${verifyCabinet.name}`">
            <v-card-text>
              <v-alert density="compact" variant="tonal" color="deep-purple" class="mb-4">
                本次提交基于柜位版本 <b>v{{ verifyBaseVersion }}</b>；若提交前版本被另一负责人推进，本次提交整体不生效。
              </v-alert>
              <v-alert v-if="verifyConflict" color="red-lighten-4" icon="mdi-source-branch-sync" class="mb-4">
                <div class="mb-2">版本冲突：提交基于 v{{ verifyConflict.expected }}，当前已是 v{{ verifyConflict.current }}，本次提交未生效。</div>
                <div class="mb-2">受影响展品（环境签字已被另一提交作废）：{{ verifyConflict.affected.map((item) => item.code).join('、') || '无' }}</div>
                <v-btn size="small" color="red" @click="openVerify(verifyCabinet!)">读取最新版本后重填</v-btn>
              </v-alert>
              <v-text-field v-model.number="verifyForm.temperature" type="number" step="0.1" label="温度 ℃" />
              <v-text-field v-model.number="verifyForm.humidity" type="number" label="湿度 %" />
              <v-text-field v-model.number="verifyForm.light" type="number" label="照度 lux" />
              <v-text-field v-model="verifyForm.verifier" label="负责人" />
              <v-btn color="deep-purple" block @click="submitVerify">提交柜位核验</v-btn>
            </v-card-text>
          </v-card>
        </v-dialog>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.ledger-list { max-height: 560px; overflow-y: auto; }
</style>
