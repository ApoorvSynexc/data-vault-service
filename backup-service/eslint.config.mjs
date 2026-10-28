import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.browser },
  },
  tseslint.configs.recommended,
  {
    rules: {
      // TypeScript
      '@typescript-eslint/no-unused-vars': ['warn'],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-async-promise-executor': 'off',

      // Code Quality
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-var': 'error',
      'prefer-const': 'error',
      semi: 'error',

      // Best practices
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],

      // Imports
      'no-duplicate-imports': 'error',
    },
  },
  {
    // Salesforce RTR: every Salesforce call must go through the shared request
    // wrapper so a 401 waits for the single token refresh and is replayed once.
    // A hand-built "Authorization: Bearer ..." header bypasses that and breaks
    // under refresh token rotation — only the wrapper itself may build one.
    files: ['src/**/*.ts'],
    ignores: [
      'src/services/third-party/salesforce/api-request.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TemplateElement[value.raw=/^Bearer /]',
          message:
            'Build Salesforce requests with salesforceRequest/salesforceFetch — never a raw Bearer header (breaks token refresh/rotation).',
        },
      ],
    },
  },
  {
    ignores: ['node_modules', 'dist'],
  },
]);
