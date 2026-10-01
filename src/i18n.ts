import { createI18n } from 'vue-i18n';

export const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: {
    zh: {
      title: '博物馆展品点交与布展条件核验',
      checkIn: '展品点交',
      environment: '柜位环境',
      discrepancies: '差异项',
      ledger: '核验账'
    }
  }
});
