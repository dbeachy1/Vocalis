module.exports = {
    root: true,
    plugins: [
        'jest',
        'playwright',
    ],
    extends: [
        'eslint:recommended',
        'plugin:jest/recommended',
        'plugin:playwright/recommended',
    ],
    env: {
        es6: true,
        node: true,
        browser: true,
        jquery: true,
        'jest/globals': true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    overrides: [
    ],
    ignorePatterns: [
        '*.min.js',
        'node_modules/**/*',
    ],
    globals: {
        // `env.es6` predates `globalThis` (ES2020), so specs reaching for it — the browser specs read app
        // state through `globalThis.SillyTavern.getContext()` — were failing `no-undef`. Declared rather
        // than bumping `env`, to match how the root .eslintrc.cjs declares it for `public/**/*.js`.
        globalThis: 'readonly',
        SillyTavern: 'readonly',
    },
    rules: {
        'no-unused-vars': ['error', { args: 'none' }],
        'no-control-regex': 'off',
        'no-constant-condition': ['error', { checkLoops: false }],
        'require-yield': 'off',
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'indent': ['error', 4, { SwitchCase: 1, FunctionDeclaration: { parameters: 'first' } }],
        'comma-dangle': ['error', 'always-multiline'],
        'eol-last': ['error', 'always'],
        'no-trailing-spaces': 'error',
        'object-curly-spacing': ['error', 'always'],
        'space-infix-ops': 'error',
        'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
        'no-cond-assign': 'error',

        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
    },
    settings: {
        jest: {
            version: 29,
        },
    },
};
