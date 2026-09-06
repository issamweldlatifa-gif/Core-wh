import parser from '@typescript-eslint/parser';
import hooks from 'eslint-plugin-react-hooks';

// Correctness lint, not an Admin redesign or mass style migration.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  { files: ['src/**/*.{ts,tsx}'], plugins: { 'react-hooks': hooks }, languageOptions: { parser, ecmaVersion: 2022, sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: { 'no-debugger': 'error', 'no-dupe-else-if': 'error', 'no-duplicate-case': 'error',
      'no-unreachable': 'error', 'no-constant-binary-expression': 'error', 'constructor-super': 'error' } },
];
