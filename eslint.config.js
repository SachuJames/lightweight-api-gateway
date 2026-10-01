import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'examples/**',
      '**/fixtures/**',
      '**/migrations/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-console': 'warn',
    },
  },
  {
    files: ['**/*.config.ts', '**/*.config.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Test code routinely pokes at `any` boundaries (res.json(), fixtures);
      // strict any-propagation rules are noise here. Production code in src/
      // keeps the full strictTypeChecked set.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Async fakes/stubs without await are idiomatic when implementing async
      // interfaces in tests.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
