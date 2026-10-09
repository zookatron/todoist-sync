import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Generated, vendored, or build output — none of it is hand-maintained.
    ignores: [
      'server/glassfrog/generated/**',
      'server/glassfrog/generated-v3/**',
      'server/todoist/generated/**',
      'openapi/**',
      'drizzle/**',
      '.react-router/**',
      'build/**',
      'node_modules/**',
    ],
  },

  js.configs.recommended,

  // Type-aware linting. Slower than the syntactic-only preset, but this codebase is
  // almost entirely async database and HTTP calls, where no-floating-promises and
  // no-misused-promises catch real bugs that `tsc` does not.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
  },

  // React rules apply to the UI only. eslint-plugin-react itself is omitted: it has no
  // release compatible with ESLint 10, and TypeScript already covers most of what it
  // checks. react-hooks is the part that catches genuine bugs.
  {
    files: ['app/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    rules: {
      // Match the previous Biome setup: unused values are errors, but an underscore
      // prefix marks a deliberate discard.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Awaiting a non-promise is harmless and common when a helper may become async.
      '@typescript-eslint/await-thenable': 'warn',
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // `throw redirect(...)` is the React Router idiom for short-circuiting a loader,
      // and redirect() returns a Response. Throwing anything else is still an error.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'lib', name: 'Response' }] },
      ],
    },
  },

  // Config files run outside the app's tsconfig project graph.
  //
  // The preset's `rules` must be spread explicitly — a bare `rules` key here would
  // replace it wholesale and leave the type-aware rules on, which then crash for want
  // of type information.
  {
    files: ['*.config.{js,ts}', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-console': 'off',
    },
  },

  // Tests deliberately poke at loose shapes, and frequently need an `async` callback
  // that never awaits — simply to satisfy a Promise-returning signature.
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // Must stay last: switches off every rule that would fight Prettier.
  prettier,
)
