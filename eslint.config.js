// Flat ESLint config (ESLint 9 + typescript-eslint 8).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, deps, and the legacy Python sketch are not linted.
    ignores: ['dist/**', 'node_modules/**', 'legacy/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow intentionally-unused names prefixed with underscore.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
