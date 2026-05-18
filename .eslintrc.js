// @ts-check
/** @type {import('@typescript-eslint/utils').TSESLint.Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json', './tsconfig.test.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    // Disallow any except where intentional casts are documented
    '@typescript-eslint/no-explicit-any': 'warn',
    // Prevent accidental floating promises (common VS Code bug source)
    '@typescript-eslint/no-floating-promises': 'error',
    // Enforce consistent return types on public functions
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    // Allow non-null assertions sparingly (VS Code API uses them)
    '@typescript-eslint/no-non-null-assertion': 'warn',
    // Unused vars catch dead imports early
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Prefer const
    'prefer-const': 'error',
    // No console.log in extension code — use VS Code output channel
    'no-console': 'error',
  },
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['out/', 'node_modules/', '*.js'],
  overrides: [
    {
      // Test files: relax non-null assertions (standard in Vitest expect chains)
      files: ['src/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
