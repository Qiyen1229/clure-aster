/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /** 'off' 關閉帳號系統（純本機模式）；預設需要登入 */
  readonly VITE_AUTH_MODE?: 'required' | 'off';
}
