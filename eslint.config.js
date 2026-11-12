import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause > BlockStatement[body.length=0]',
          message: 'Empty catch blocks are forbidden — handle or propagate the error.',
        },
      ],
    },
  },
  {
    // Dependency direction: the HTTP server and the shared use cases are
    // adapters' targets, never their dependents; the browser bundle only sees
    // the domain and the contracts it needs.
    files: ['src/server/**/*.ts', 'src/application/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**'],
              message: 'server and application code must not depend on the CLI adapter.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/client/**/*.ts', 'src/client/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '**/cli/**', '**/db/**', '**/application/**'],
              allowTypeImports: true,
              message: 'the client talks to the server over HTTP; only its types may be imported.',
            },
          ],
        },
      ],
    },
  },
  {
    // Vendored shadcn source. These files are re-copied verbatim by
    // `shadcn add`, so hand-annotating them means re-doing the work on every
    // component update; the project's own code keeps the full rule set.
    files: ['src/client/components/ui/**'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
