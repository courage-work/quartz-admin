import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { plugin as shadcn } from '@shadcn/lint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/.next/**',
    '**/out/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/next-env.d.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // NestJS DI는 생성자 파라미터 타입의 런타임 메타데이터가 필요하므로
      // 클래스 import를 `import type`으로 바꾸는 규칙은 켜지 않는다.
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  // 디자인 시스템 규칙 (docs/DESIGN.md §린트). 화면 코드가 토큰과 컴포넌트 variant를 벗어나지 않게 한다.
  {
    files: ['apps/web/src/**/*.tsx'],
    // shadcn 원본 컴포넌트는 스타일을 정의하는 곳이므로 대상에서 뺀다
    ignores: ['apps/web/src/components/ui/**'],
    plugins: { shadcn },
    settings: {
      shadcn: {
        ui: ['@/components/ui'],
        note: '토큰과 variant는 apps/web/src/app/globals.css, docs/DESIGN.md를 참고하세요.',
      },
    },
    rules: {
      'shadcn/no-restyle': ['error', { allow: ['layout'] }],
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/no-unknown-classes': 'error',
      'shadcn/require-static-classes': 'error',
    },
  },
  prettier,
);
