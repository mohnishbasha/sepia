// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', '**/node_modules/**', 'examples/*/dist/**'],
  },

  ...tseslint.configs.recommended,

  // Global rules
  {
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Allow _prefixed params/vars to mark intentionally unused stubs
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Core modules: serializer, resolver, fingerprint, privacy, telemetry, config, types
  // must NOT import from agent, actions, engine, interfaces, or cli.
  {
    files: [
      'serializer/**/*.ts',
      'resolver/**/*.ts',
      'fingerprint/**/*.ts',
      'privacy/**/*.ts',
      'telemetry/**/*.ts',
      'config/**/*.ts',
      'types/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../agent*', '../../agent*'],
              message: 'Core modules must not import from agent/.',
            },
            {
              group: ['../actions*', '../../actions*'],
              message: 'Core modules must not import from actions/.',
            },
            {
              group: ['../engine*', '../../engine*'],
              message: 'Core modules must not import from engine/.',
            },
            {
              group: ['../interfaces*', '../../interfaces*'],
              message: 'Core modules must not import from interfaces/.',
            },
            {
              group: ['../cli*', '../../cli*'],
              message: 'Core modules must not import from cli/.',
            },
          ],
        },
      ],
    },
  },

  // actions: must not import from agent, interfaces, or cli
  {
    files: ['actions/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../agent*'], message: 'actions/ must not import from agent/.' },
            { group: ['../interfaces*'], message: 'actions/ must not import from interfaces/.' },
            { group: ['../cli*'], message: 'actions/ must not import from cli/.' },
          ],
        },
      ],
    },
  },

  // engine: must not import from agent, actions, interfaces, or cli
  {
    files: ['engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['../agent*'], message: 'engine/ must not import from agent/.' },
            { group: ['../actions*'], message: 'engine/ must not import from actions/.' },
            { group: ['../interfaces*'], message: 'engine/ must not import from interfaces/.' },
            { group: ['../cli*'], message: 'engine/ must not import from cli/.' },
          ],
        },
      ],
    },
  },

  // privacy/index.ts uses let for mutation-checked variables — allow prefer-const exceptions
  {
    files: ['privacy/**/*.ts'],
    rules: {
      'prefer-const': 'off',
    },
  },
);
