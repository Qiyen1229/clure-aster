/**
 * 多語系架構（i18next）。採「中文原文即 key」的方式：預設語言 zh-TW 直接顯示原文，
 * 其他語言在 en.json 等檔案中以原文對應翻譯；缺漏時自動回退成中文，不會出現空字串。
 * 使用：const { t } = useTranslation(); t('新增帳戶')
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';

void i18n.use(initReactI18next).init({
  lng: 'zh-TW',
  fallbackLng: false,
  resources: { 'zh-TW': { translation: {} }, en: { translation: en } },
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

export default i18n;
