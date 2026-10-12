module.exports = {
    root: true,
    extends: [
        'eslint:recommended',
    ],
    plugins: [
        'jsdoc',
    ],
    env: {
        es6: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
    },
    overrides: [
        {
            // Server-side files (plus this configuration file)
            files: ['src/**/*.js', './*.js', 'plugins/**/*.js'],
            env: {
                node: true,
            },
            parserOptions: {
                sourceType: 'module',
            },
            globals: {
                globalThis: 'readonly',
                Deno: 'readonly',
            },
            rules: {
                // The log hygiene invariant, enforced rather than remembered. A raw console call
                // writes to stdout, which under systemd is the journal: plaintext, persistent,
                // readable by adm, and readable while the vault is locked. Route it through
                // src/logger.js and classify it.
                //
                // This exists because the fork tracks an upstream carrying well over a thousand of
                // these, so the regression pressure is continuous and permanent. A rule that fails
                // the build is worth more than any amount of vigilance.
                'no-console': 'error',

                // An ERROR line may never be suppressed in its entirety. A suppressed error prints
                // `[ERROR] [SENSITIVE suppressed: chats.js:594]` — a call site is *where*, not
                // *what*, so the operator has to open the source to find out that renaming a chat
                // failed. A real install emitted five of these in two seconds and nothing else.
                // Every `log.error(LogClass.SENSITIVE, …)` must therefore be introduced by a
                // `log.error(LogClass.NORMAL, …)` line saying what broke. See §5.3.1, which narrows
                // the "a split is only required when a safe VALUE would be lost" rule by level:
                // that rule still governs DEBUG, INFO and WARN, where the reader is tracing rather
                // than triaging.
                //
                // Same argument as `no-console` above, and for the same reason: the fork tracks an
                // upstream that keeps adding error sites, so 492 hand-fixed call sites start
                // rotting the day they land unless a rule fails the build.
                //
                // A run of SENSITIVE lines needs only one NORMAL line to introduce it, so the
                // selector accepts a preceding SENSITIVE sibling and reports only the head of an
                // unaccompanied run. It is deliberately structural — adjacent siblings — rather
                // than clever: the one site in the tree where the pair is legitimately not adjacent
                // carries an eslint-disable naming its reason.
                'no-restricted-syntax': ['error', {
                    selector: "ExpressionStatement[expression.callee.object.name='log'][expression.callee.property.name='error'][expression.arguments.0.property.name='SENSITIVE']:not(:matches(ExpressionStatement[expression.callee.object.name='log'][expression.callee.property.name='error'][expression.arguments.0.property.name='NORMAL'], ExpressionStatement[expression.callee.object.name='log'][expression.callee.property.name='error'][expression.arguments.0.property.name='SENSITIVE']) + ExpressionStatement)",
                    message: 'A suppressed ERROR must be introduced by log.error(LogClass.NORMAL, …) saying what failed, or the log line tells the operator nothing but a call site. See DESIGN_LOG_HYGIENE.md §5.3.1.',
                }],
            },
        },
        {
            // The one module allowed to touch console: it installs the seam that captures
            // third-party library output and routes it into the log.
            files: ['src/logger.js'],
            rules: {
                'no-console': 'off',
            },
        },
        {
            // Operator-invoked CLI tools and the build config, none of which run inside the server
            // process. Their stdout is a terminal someone is looking at, not a systemd journal, and
            // printing is the entire point of them. The log hygiene invariant is about the server.
            files: ['plugins.js', 'recover.js', 'webpack.config.js'],
            rules: {
                'no-console': 'off',
            },
        },
        {
            // ESM tooling under tools/ — operator-invoked, never loaded by the server. Without this the
            // parser defaults to script and every import is a parse error, which silently meant tools/
            // was not linted at all.
            //
            // ⚠️ SCOPED TO tools/, NOT BARE `*.mjs`. An `files: ['*.mjs']` entry matches by BASENAME at any
            // depth, so it turned `no-console` off for anything named `*.mjs` anywhere — including a future
            // `src/foo.mjs`, which would then be exempt from the log-hygiene rule this fork treats as
            // load-bearing. The `src/**/*.mjs` override below re-specifies the parser and does not restore
            // the rule, so nothing else would have caught it.
            files: ['tools/**/*.mjs'],
            parserOptions: {
                sourceType: 'module',
                ecmaVersion: 2024,
            },
            env: {
                node: true,
                es2024: true,
            },
            rules: {
                'no-console': 'off',
            },
        },
        {
            files: ['*.cjs'],
            parserOptions: {
                sourceType: 'commonjs',
            },
            env: {
                node: true,
            },
        },
        {
            files: ['src/**/*.mjs'],
            parserOptions: {
                sourceType: 'module',
            },
            env: {
                node: true,
            },
        },
        {
            // Browser-side files
            files: ['public/**/*.js'],
            env: {
                browser: true,
                jquery: true,
            },
            parserOptions: {
                sourceType: 'module',
            },
            // These scripts are loaded in HTML; tell ESLint not to complain about them being undefined
            globals: {
                globalThis: 'readonly',
                ePub: 'readonly',
                pdfjsLib: 'readonly',
                toastr: 'readonly',
                SillyTavern: 'readonly',
            },
        },
    ],
    ignorePatterns: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        'public/lib/**',
        'public/scripts/extensions/third-party/**',
        'backups/**',
        'data/**',
        'cache/**',
        'src/tokenizers/**',
        'docker/**',
        'plugins/**',
        '**/*.min.js',
        'public/scripts/extensions/quick-reply/lib/**',
        'public/scripts/extensions/tts/lib/**',
    ],
    rules: {
        'jsdoc/no-undefined-types': ['warn', { disableReporting: true, markVariablesAsUsed: true }],
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
        'no-unneeded-ternary': 'error',
        'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
        'dot-notation': ['error', { 'allowPattern': '[A-Z]\\w*$' }],
        // These rules should eventually be enabled.
        'no-async-promise-executor': 'off',
        'no-inner-declarations': 'off',
        // Additional formatting rules based on codebase conventions
        'brace-style': ['error', '1tbs', { allowSingleLine: true }],
        'array-bracket-spacing': ['error', 'never'],
        'computed-property-spacing': ['error', 'never'],
        'block-spacing': ['error', 'always'],
        'keyword-spacing': ['error', { before: true, after: true }],
        'space-before-blocks': ['error', 'always'],
        'space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
        'space-in-parens': ['error', 'never'],
        'comma-spacing': ['error', { before: false, after: true }],
        'key-spacing': ['error', { beforeColon: false, afterColon: true }],
        'func-call-spacing': ['error', 'never'],
        'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
        'padded-blocks': ['error', 'never'],
        'no-whitespace-before-property': 'error',
        'space-unary-ops': ['error', { words: true, nonwords: false }],
        'arrow-spacing': ['error', { before: true, after: true }],
        'template-curly-spacing': ['error', 'never'],
        'rest-spread-spacing': ['error', 'never'],
        'generator-star-spacing': ['error', { before: false, after: true }],
        'yield-star-spacing': ['error', { before: false, after: true }],
        'template-tag-spacing': ['error', 'never'],
        'switch-colon-spacing': ['error', { after: true, before: false }],
    },
};
