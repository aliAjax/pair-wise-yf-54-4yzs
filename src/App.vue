<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { storeToRefs } from 'pinia';
import { useExhibitionStore, type ActionResult, type Cabinet, type Exhibit, type Signature } from './stores/exhibition';
import { requiredSignatures } from './services/ledger';

const store = useExhibitionStore();
const { cabinets, exhibits, discrepancies, pendingOps, writeFailure } = storeToRefs(store);
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const snackbar = reactive({ show: false, text: '', color: 'deep-purple' });
const conflictByCabinet = reactive<Record<string, ActionResult | null>>({});

const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), cabinetId: z.string().min(1) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [cabinetId] = defineField('cabinetId');

/** 柜位读数草稿（同一柜位展品共用）。 */
const drafts = reactive<Record<string, { temperature: number; humidity: number; light: number }>>({});
for (const cabinet of cabinets.value) {
  drafts[cabinet.id] = { ...cabinet.environment };
}

function notify(result: ActionResult | undefined, okText: string) {
  if (!result) return;
  if (result.ok) {
    snackbar.text = okText;
    snackbar.color = 'green';
  } else {
    snackbar.text = result.message;
    snackbar.color = result.reason === 'version_conflict' ? 'orange-darken-3' : 'red';
  }
  snackbar.show = true;
}

const submit = handleSubmit((values) => {
  notify(store.addExhibit(values), '展品已登记并写入点交队列');
  dialog.value = false;
  resetForm();
});

function stageLabel(stage: Exhibit['stage']) {
  return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage];
}

function cabinetName(cabinetId: string) {
  return cabinets.value.find((c) => c.id === cabinetId)?.name ?? cabinetId;
}

function signaturesOf(exhibitId: string): Signature[] {
  return store.signaturesFor(exhibitId);
}

/** 当前阶段应备签字及状态。 */
function signatureState(exhibit: Exhibit | null) {
  if (!exhibit) return [];
  const cabinet = store.cabinetFor(exhibit.id);
  return requiredSignatures(exhibit.stage).map((req) => {
    const sig = store.signatures.find((item) =>
      item.exhibitId === exhibit.id && item.role === req.role && item.kind === req.kind);
    let state: 'missing' | 'valid' | 'stale' = 'missing';
    if (sig) state = sig.status === 'stale' || (req.kind === 'environment' && sig.cabinetVersion !== cabinet?.version) ? 'stale' : 'valid';
    return { ...req, state };
  });
}

function sign(exhibit: Exhibit | null, role: string, kind: 'handover' | 'environment') {
  if (!exhibit) return;
  notify(store.sign(exhibit.id, role, kind), kind === 'environment' ? '环境签字已记录' : '签字已记录');
}

function advance(exhibit: Exhibit | null) {
  if (!exhibit) return;
  notify(store.advance(exhibit.id), '已推进到下一阶段');
}

function saveReadings(cabinet: Cabinet) {
  notify(store.updateCabinetReadings(cabinet.id, drafts[cabinet.id]), '柜位读数已保存，依赖读数的环境签字已作废');
}

function submitEnvironment(cabinet: Cabinet, stale = false) {
  const baseVersion = stale ? cabinet.version - 1 : cabinet.version;
  const result = store.submitEnvironmentCheck(cabinet.id, drafts[cabinet.id], '布展负责人', baseVersion);
  conflictByCabinet[cabinet.id] = result.ok ? null : result;
  notify(result, '柜位环境核验已提交，受影响展品已完成环境签字');
}

function addDiscrepancy(exhibitId: string, title: string, severity: 'minor' | 'major') {
  notify(store.addDiscrepancy(exhibitId, title, severity), '差异项已登记，该展品整组签字失效');
}

function onAddDiscrepancy(event: Event) {
  const form = event.target as HTMLFormElement;
  const fd = new FormData(form);
  addDiscrepancy(String(fd.get('exhibitId')), String(fd.get('title')), fd.get('severity') === 'major' ? 'major' : 'minor');
  form.reset();
}

interface ConflictResult {
  ok: false;
  reason: 'version_conflict';
  message: string;
  currentVersion: number;
  affectedExhibits: string[];
}

/** 取某柜位的冲突结果（仅失败分支），供模板类型收窄。 */
function conflictOf(cabinetId: string): ConflictResult | null {
  const result = conflictByCabinet[cabinetId];
  return result && !result.ok && result.reason === 'version_conflict' ? (result as unknown as ConflictResult) : null;
}

function resolveDiscrepancy(id: string) {
  notify(store.resolveDiscrepancy(id), '差异已解决，该展品签字需重新核验');
}

function retryAll() {
  const result = store.syncQueue();
  snackbar.text = `补写完成：已补 ${result.applied} 笔，跳过重复 ${result.skipped} 笔，待重试 ${result.pending} 笔`;
  snackbar.color = result.pending ? 'orange-darken-3' : 'green';
  snackbar.show = true;
}

const pendingCount = computed(() => pendingOps.value.length);
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-switch
        v-model="writeFailure"
        hide-details
        density="compact"
        color="orange"
        label="模拟写盘失败"
        class="mr-3"
      />
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || pendingCount" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          写盘失败不丢核验：当前有 {{ pendingCount }} 笔待重试项，恢复后只补未完成核验，重复提交不生成第二套签字。
          <template #append>
            <v-btn v-if="online" variant="text" @click="retryAll">确认同步</v-btn>
          </template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待重试项</div><div class="metric" :class="{ warn: pendingCount }">{{ pendingCount }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab>
            <v-tab value="environment">{{ $t('environment') }}</v-tab>
            <v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <!-- 展品点交 -->
            <v-window-item value="checkin">
              <v-virtual-scroll :items="exhibits" height="560" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>
                      {{ item.lender }} · {{ cabinetName(item.cabinetId) }} · {{ stageLabel(item.stage) }}
                    </v-list-item-subtitle>
                    <template #append>
                      <v-chip
                        v-for="sig in signaturesOf(item.id)"
                        :key="sig.id"
                        size="small"
                        class="mr-1"
                        :color="sig.status === 'stale' ? 'red' : 'green'"
                      >{{ sig.role }}{{ sig.status === 'stale' ? '·过期' : '' }}</v-chip>
                      <v-chip size="small" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>

            <!-- 柜位环境 -->
            <v-window-item value="environment">
              <v-row class="pa-4">
                <v-col v-for="cabinet in cabinets" :key="cabinet.id" cols="12" md="6">
                  <v-card variant="outlined">
                    <v-card-title class="d-flex align-center">
                      <span>{{ cabinet.name }}</span>
                      <v-chip size="small" class="ml-2" color="deep-purple-lighten-4">v{{ cabinet.version }}</v-chip>
                      <v-spacer />
                      <v-chip size="small" variant="text">{{ store.exhibitsInCabinet(cabinet.id).length }} 件展品共用</v-chip>
                    </v-card-title>
                    <v-card-text>
                      <v-row>
                        <v-col cols="4"><v-text-field v-model.number="drafts[cabinet.id].temperature" label="温度 ℃" type="number" density="compact" hide-details /></v-col>
                        <v-col cols="4"><v-text-field v-model.number="drafts[cabinet.id].humidity" label="湿度 %" type="number" density="compact" hide-details /></v-col>
                        <v-col cols="4"><v-text-field v-model.number="drafts[cabinet.id].light" label="照度 lux" type="number" density="compact" hide-details /></v-col>
                      </v-row>
                      <v-alert
                        v-if="conflictOf(cabinet.id)"
                        type="warning"
                        variant="tonal"
                        class="mt-3"
                        :title="conflictOf(cabinet.id)!.message"
                      >
                        <div>受影响展品（{{ conflictOf(cabinet.id)!.affectedExhibits.length }} 件）：
                          <v-chip
                            v-for="id in conflictOf(cabinet.id)!.affectedExhibits"
                            :key="id"
                            size="small"
                            class="ml-1"
                          >{{ id }}</v-chip>
                        </div>
                      </v-alert>
                      <div class="mt-3">
                        <v-btn size="small" color="deep-purple" variant="tonal" @click="submitEnvironment(cabinet)">提交柜位核验</v-btn>
                        <v-btn size="small" variant="text" class="ml-2" @click="submitEnvironment(cabinet, true)">模拟后到者（旧版本）</v-btn>
                        <v-btn size="small" variant="text" @click="saveReadings(cabinet)">仅保存读数</v-btn>
                      </div>
                      <v-divider class="my-3" />
                      <div class="text-subtitle-2 mb-2">柜内展品条件</div>
                      <v-list density="compact">
                        <v-list-item v-for="ex in store.exhibitsInCabinet(cabinet.id)" :key="ex.id">
                          <v-list-item-title>{{ ex.code }} · {{ ex.name }}</v-list-item-title>
                          <template #append>
                            <v-btn size="small" color="green" variant="text" @click="notify(store.setCondition(ex.id, 'passed'), '条件已通过')">通过</v-btn>
                            <v-btn size="small" color="red" variant="text" @click="notify(store.setCondition(ex.id, 'issue'), '已标记异常')">异常</v-btn>
                          </template>
                        </v-list-item>
                      </v-list>
                    </v-card-text>
                  </v-card>
                </v-col>
              </v-row>
            </v-window-item>

            <!-- 差异项 -->
            <v-window-item value="discrepancy">
              <v-card-text>
                <v-form @submit.prevent="onAddDiscrepancy">
                  <v-row>
                    <v-col cols="12" md="4">
                      <v-select name="exhibitId" :items="exhibits" item-title="code" item-value="id" label="归属展品" density="compact" hide-details />
                    </v-col>
                    <v-col cols="12" md="4"><v-text-field name="title" label="差异描述" density="compact" hide-details /></v-col>
                    <v-col cols="12" md="2">
                      <v-select name="severity" :items="[{ title: '轻微差异', value: 'minor' }, { title: '重大差异', value: 'major' }]" label="严重程度" density="compact" hide-details />
                    </v-col>
                    <v-col cols="12" md="2"><v-btn type="submit" color="deep-purple" block>登记差异</v-btn></v-col>
                  </v-row>
                </v-form>
                <v-alert type="info" variant="tonal" class="mt-3">
                  单件差异变化只让该展品整组签字失效；同柜位其他展品的签字结论保持不变。
                </v-alert>
              </v-card-text>
              <v-list>
                <v-list-item v-for="item in discrepancies" :key="item.id">
                  <v-list-item-title>{{ item.title }}</v-list-item-title>
                  <v-list-item-subtitle>
                    {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }} ·
                    <span :class="item.resolved ? 'text-green' : 'text-red'">{{ item.resolved ? '已解决' : '未解决' }}</span>
                  </v-list-item-subtitle>
                  <template #append>
                    <v-btn :disabled="item.resolved" color="green" @click="resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn>
                  </template>
                </v-list-item>
              </v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <!-- 展品核验账详情 -->
        <v-dialog :model-value="Boolean(selected)" max-width="720" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-alert
                v-if="store.discrepancies.some((d) => d.exhibitId === selected?.id && !d.resolved)"
                type="warning"
                variant="tonal"
                class="mb-3"
              >该展品存在未解决差异，推进将被拦下重核。</v-alert>
              <v-timeline side="end" density="compact">
                <v-timeline-item
                  v-for="req in signatureState(selected)"
                  :key="`${req.kind}-${req.role}`"
                  :dot-color="req.state === 'valid' ? 'green' : req.state === 'stale' ? 'red' : 'grey'"
                >
                  <b>{{ req.role }}{{ req.kind === 'environment' ? '（环境核验）' : '（交接核验）' }}</b>
                  <p v-if="req.state === 'missing'">尚未签字。</p>
                  <p v-else-if="req.state === 'stale'" class="text-red">签字已过期：依赖的柜位读数或差异项发生变化，需重新核验签字。</p>
                  <p v-else class="text-green">签字有效。</p>
                  <v-btn
                    size="small"
                    :color="req.kind === 'environment' ? 'deep-purple' : undefined"
                    :variant="req.state === 'valid' ? 'tonal' : 'flat'"
                    @click="sign(selected, req.role, req.kind)"
                  >{{ req.state === 'valid' ? '重新签字' : `${req.role}签字` }}</v-btn>
                </v-timeline-item>
                <v-timeline-item dot-color="purple">
                  <b>推进阶段</b>
                  <p>未执行的推进停下来重核；已安装展品保持现场位置，只向前推进。</p>
                  <v-btn size="small" color="deep-purple" @click="advance(selected)">推进到下一阶段</v-btn>
                </v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>

        <!-- 登记展品 -->
        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text>
              <v-form @submit.prevent="submit">
                <v-text-field v-model="code" label="展品编号" :error-messages="errors.code" />
                <v-text-field v-model="name" label="展品名称" :error-messages="errors.name" />
                <v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" />
                <v-select
                  v-model="cabinetId"
                  :items="cabinets"
                  item-title="name"
                  item-value="id"
                  label="柜位"
                  :error-messages="errors.cabinetId"
                />
                <v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn>
              </v-form>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-snackbar v-model="snackbar.show" :color="snackbar.color" timeout="4000">
          {{ snackbar.text }}
        </v-snackbar>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
</style>
