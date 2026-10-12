#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

function parseArguments(args) {
    const result = { check: false, configPath: '', dataRoot: '' };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--check') {
            result.check = true;
            continue;
        }
        if (argument !== '--configPath' && argument !== '--dataRoot') {
            throw new Error(`Unknown argument: ${argument}`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`Missing value for ${argument}`);
        }
        result[argument === '--configPath' ? 'configPath' : 'dataRoot'] = value;
        index += 1;
    }
    if (!path.isAbsolute(result.configPath) || !path.isAbsolute(result.dataRoot)) {
        throw new Error('Absolute --configPath and --dataRoot values are required.');
    }
    return result;
}

function readSecret(prompt) {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        throw new Error('Owner provisioning requires an interactive terminal so passwords are not echoed.');
    }

    return new Promise((resolve, reject) => {
        const bytes = [];
        const priorRawMode = stdin.isRaw;
        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();

        const finish = (error) => {
            stdin.off('data', onData);
            stdin.setRawMode(priorRawMode ?? false);
            stdin.pause();
            stdout.write('\n');
            if (error) {
                reject(error);
            } else {
                resolve(Buffer.from(bytes).toString('utf8'));
            }
        };

        const onData = (chunk) => {
            for (const byte of chunk) {
                if (byte === 3) {
                    finish(new Error('Owner provisioning was cancelled.'));
                    return;
                }
                if (byte === 4) {
                    finish(new Error('Owner provisioning was cancelled.'));
                    return;
                }
                if (byte === 13 || byte === 10) {
                    finish();
                    return;
                }
                if (byte === 8 || byte === 127) {
                    bytes.pop();
                    continue;
                }
                if (byte >= 32) {
                    bytes.push(byte);
                }
            }
        };

        stdin.on('data', onData);
    });
}

function normalizeHandle(value) {
    const handle = String(value ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(handle)) {
        throw new Error('Handle must use 1–32 lowercase letters, digits, or interior hyphens.');
    }
    return handle;
}

function assertDockerConfig(getConfigValue) {
    const required = [
        ['enableUserAccounts', true, 'boolean'],
        ['basicAuthMode', false, 'boolean'],
        ['perUserBasicAuth', false, 'boolean'],
        ['sso.autheliaAuth', false, 'boolean'],
        ['sso.authentikAuth', false, 'boolean'],
        ['browserLaunch.enabled', false, 'boolean'],
        ['whitelistMode', false, 'boolean'],
        ['enableForwardedWhitelist', false, 'boolean'],
        ['securityOverride', false, 'boolean'],
        ['disableCsrfProtection', false, 'boolean'],
        ['enableServerPlugins', true, 'boolean'],
        ['enableServerPluginsAutoUpdate', false, 'boolean'],
        ['extensions.enabled', true, 'boolean'],
        ['extensions.autoUpdate', false, 'boolean'],
        ['storageProvidersRequiredId', 'vault'],
    ];
    for (const [key, expected, converter] of required) {
        const actual = getConfigValue(key, undefined, converter);
        if (actual !== expected) {
            throw new Error(`Docker setup requires ${key}=${expected}.`);
        }
    }
}

function ensureImageConfig(configPath) {
    if (fs.existsSync(configPath)) {
        return;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const imageConfig = fileURLToPath(new URL('./config.yaml', import.meta.url));
    try {
        fs.copyFileSync(imageConfig, configPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(configPath, 0o600);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

async function main() {
    let accountStorage;
    try {
        const args = parseArguments(process.argv.slice(2));
        ensureImageConfig(args.configPath);
        const { initConfig } = await import('./src/config-init.js');
        initConfig(args.configPath);
        const { getConfigValue } = await import('./src/util.js');
        assertDockerConfig(getConfigValue);

        ({ default: accountStorage } = await import('node-persist'));
        const users = await import('./src/users.js');
        const { DEFAULT_USER } = await import('./src/constants.js');

        const accountsDirectory = path.join(args.dataRoot, '_storage');
        if (args.check) {
            if (!fs.existsSync(accountsDirectory)) {
                throw new Error('Taproom owner is not provisioned. Run the owner provisioning command first.');
            }
            await accountStorage.init({ dir: accountsDirectory, ttl: false, expiredInterval: 0 });
            const enabledUsers = await users.getAllEnabledUsers();
            const owner = enabledUsers.find(user => user.admin && user.password);
            if (!owner || enabledUsers.some(user => !user.password)) {
                throw new Error('Taproom must have a passworded admin and no enabled passwordless accounts.');
            }
            return;
        }

        if (fs.existsSync(args.dataRoot) && fs.readdirSync(args.dataRoot).length > 0) {
            throw new Error('Owner provisioning only accepts a new, empty data root. Existing or interrupted data was left unchanged.');
        }
        fs.mkdirSync(args.dataRoot, { recursive: true, mode: 0o700 });

        const terminal = readline.createInterface({ input: stdin, output: stdout });
        let handle;
        try {
            handle = normalizeHandle(await terminal.question('Owner handle: '));
        } finally {
            terminal.close();
        }

        const password = await readSecret('Owner password: ');
        const confirmation = await readSecret('Confirm password: ');
        if (!password || password.normalize() !== confirmation.normalize()) {
            throw new Error('A nonblank password and matching confirmation are required.');
        }

        await users.initUserStorage(args.dataRoot);
        const handles = await users.getAllUserHandles();
        if (handles.length !== 1 || handles[0] !== DEFAULT_USER.handle) {
            throw new Error('The new account store is not in the expected bootstrap state; no owner was written.');
        }

        const salt = users.getPasswordSalt();
        const owner = {
            handle,
            name: handle,
            created: Date.now(),
            password: users.getPasswordHash(password, salt),
            salt,
            admin: true,
            enabled: true,
        };
        if (handle === DEFAULT_USER.handle) {
            await accountStorage.setItem(users.toKey(handle), owner);
        } else {
            const bootstrap = { ...DEFAULT_USER, enabled: false };
            await accountStorage.setItem(users.toKey(DEFAULT_USER.handle), bootstrap);
            await accountStorage.setItem(users.toKey(handle), owner);
        }

        const enabledUsers = await users.getAllEnabledUsers();
        if (enabledUsers.length !== 1 || enabledUsers[0].handle !== handle || !enabledUsers[0].admin || !enabledUsers[0].password) {
            throw new Error('Owner verification failed; the account store was preserved for inspection.');
        }
        stdout.write('Taproom owner provisioned. Start the service to continue.\n');
    } finally {
        accountStorage?.stopWriteQueueInterval?.();
        accountStorage?.stopExpiredKeysInterval?.();
        stdin.pause();
    }
}

main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
