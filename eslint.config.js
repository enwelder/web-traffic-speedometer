// Generic quality gate: unused values, unreachable code, redeclaration, comparisons that
// cannot hold. The rules particular to this application — one fetch call site, no dynamic
// code, no request bodies, a complete precache list — are executable in tests/security.mjs.

import js from '@eslint/js';
import globals from 'globals';

export default [
  {ignores: ['node_modules/', 'tests/fixtures/', '.dev/', 'test-results/', 'playwright-report/']},
  js.configs.recommended,
  {
    files: ['js/**/*.js'],
    languageOptions: {ecmaVersion: 2023, sourceType: 'module', globals: globals.browser}
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
