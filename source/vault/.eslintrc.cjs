module.exports = {
    root: true,
    env: { node: true, es2022: true, jest: true },
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    extends: ['eslint:recommended'],
    rules: {
        'indent': ['error', 4],
        'quotes': ['error', 'single'],
        'semi': ['error', 'always'],
        'no-unused-vars': ['error', { args: 'after-used' }],
    },
};
