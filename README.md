# pair-wise-yf-54 博物馆展品点交与布展条件核验

## 源提示词摘要
策展人、保管员、布展负责人和借展方从到场点交、环境条件检查、安装位置确认到闭展归还共同处理展品。系统记录条件、附件、风险等级、照片说明、处理意见和签字结果，差异项未解决时不能进入下一阶段，并支持大量展品与断网暂存。

## 技术栈
Vue 3 + TypeScript + Vite + Vuetify + Pinia + Vue Router + Axios + VueUse + VeeValidate + Zod + Vue I18n。

## 已实现闭环
- 展品、柜位环境、差异项、分阶段签字四类对象接成核验账。
- 同一柜位展品共用温湿度、照度读数；柜位读数变化自动作废依赖它的环境签字（签字快照柜位版本，版本不一致即过期）。
- 单件差异新增或解决只让该展品整组签字失效，同柜位其他展品签字结论不变。
- 未执行的推进停下来重核（未解决差异 / 过期签字双重门禁）；已安装展品保持现场位置，阶段只向前、不回退。
- 两名负责人同时提交同一柜位核验：先到者落盘，后到者收到版本冲突与受影响展品清单（乐观锁）。
- 写盘失败保留待重试项，恢复后只补未完成核验；签字按「展品+阶段+角色+核验类」幂等，重复提交不生成第二套签字。
- `v-virtual-scroll` 大列表、离线队列提示、手动确认同步、localStorage 持久化与旧数据迁移。

## 领域规则（src/services/ledger.ts）
- `isSignatureValid`：环境签字须比对柜位版本；其余签字看 status。
- `requiredSignatures`：到场需保管员+借展方交接签字，布展需布展负责人环境签字。
- `signatureKey`：签字幂等键。

## 启动
```bash
npm install
npm run dev
```
开发端口：62019

## 测试
```bash
npx esbuild test/ledger.test.ts --bundle --platform=node --format=esm --outfile=/tmp/ledger-test.mjs && node /tmp/ledger-test.mjs
```

