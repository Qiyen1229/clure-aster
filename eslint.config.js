// ESLint（flat config）：先抓「真的會出錯」的問題；風格交給 Prettier。
// 規則刻意從寬起步（錯誤＝會造成 bug 的；警告＝建議改善），讓 CI 可以零錯誤通過並逐步加嚴。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'server/**', 'public/**', 'aster-nas.zip', '.claude/**', '.playwright-mcp/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['docker/**/*.mjs', 'scripts/**/*.mjs'], languageOptions: { globals: { ...globals.node } } },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'proxy/**/*.ts', 'vite.config.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, __APP_VERSION__: 'readonly', __BUILD_TIME__: 'readonly' } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off', // 舊程式碼有不少 any（匯入／報價資料源）；新程式碼請用具體型別
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
      'no-irregular-whitespace': 'off', // 中文全形空白出現在字串與註解裡是正常的
      'prefer-const': 'warn',
    },
  },
);
