// Generic quality gate: unused values, unreachable code, redeclaration, comparisons that
// cannot hold. The rules particular to this application — one fetch call site, no dynamic
// code, no request bodies, a complete precache list — are executable in tests/security.mjs.

import js from '@eslint/js';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';

export default [
  {ignores: ['node_modules/', 'tests/fixtures/', '.dev/', 'test-results/', 'playwright-report/']},
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {ecmaVersion: 2023, sourceType: 'module', globals: globals.browser},
    plugins: {sonarjs},
    // How much has to be held at once to follow a function. Cognitive complexity weights
    // nesting and leaves flat structures alone, which is the distinction being made here;
    // depth and parameter count bound the two things that push it up fastest.
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      // Reports a parameter no body reads, which the default (trailing arguments only)
      // does not.
      'no-unused-vars': ['error', {args: 'all', argsIgnorePattern: '^_'}]
    }
  },
  {
    // A service worker is a classic script with its own global scope.
    files: ['sw.js'],
    languageOptions: {ecmaVersion: 2023, sourceType: 'script', globals: globals.serviceworker}
  },
  {
    // The suites run under node and stub the browser globals the modules reach for.
    files: ['tests/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {...globals.node, ...globals.browser}
    }
  }
];
