import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['node:fs*', 'node:net', 'node:http*', 'node:timers*', 'node:process'],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'The engine must use its deterministic seeded RNG.',
        },
        {
          selector: "Identifier[name='process']",
          message: 'The engine must not access environment or process state.',
        },
        {
          selector: 'CallExpression[callee.name=/^(fetch|setTimeout|setInterval)$/]',
          message: 'The engine must have zero I/O and timers.',
        },
      ],
    },
  },
  {
    files: ['apps/api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/application/**',
            '**/infrastructure/**',
            '**/interfaces/**',
            'fastify',
            'socket.io',
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/infrastructure/**', '**/interfaces/**', 'fastify', 'socket.io'] },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['@bingo/engine', '@bingo/engine/*'], paths: ['node:crypto'] },
      ],
    },
  },
);
