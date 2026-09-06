import parser from '@typescript-eslint/parser';
import typescript from '@typescript-eslint/eslint-plugin';

// Correctness lint for the existing codebase; avoid an unrelated formatting/typing rewrite.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  { files: ['src/**/*.ts'], plugins: { '@typescript-eslint': typescript }, languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-debugger': 'error', 'no-dupe-else-if': 'error', 'no-duplicate-case': 'error',
      'no-unreachable': 'error', 'no-constant-binary-expression': 'error', 'constructor-super': 'error' } },
];
