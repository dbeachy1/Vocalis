import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';

import { setConfigFilePath } from '../src/util.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSettingsPath = path.join(testDirectory, '..', 'default', 'content', 'settings.json');
let scratch;
let configRoot;
let previousDataRoot;
let previousBrowserUrl;
let nextHandle = 0;
let initializeSettings;
let getUserDirectories;

function makeUser(settingsText) {
    const directories = getUserDirectories(`vocalis-default-${process.pid}-${nextHandle++}`);
    fs.mkdirSync(directories.root, { recursive: true });
    fs.mkdirSync(directories.backups, { recursive: true });
    if (settingsText !== undefined) {
        fs.writeFileSync(path.join(directories.root, 'settings.json'), settingsText, 'utf8');
    }
    return directories;
}

describe('fresh Vocalis extension URL defaults', () => {
    beforeAll(async () => {
        configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vocalis-settings-config-'));
        const configPath = path.join(configRoot, 'config.yaml');
        fs.writeFileSync(configPath, '{}\n', 'utf8');
        setConfigFilePath(configPath);
        ({ init: initializeSettings } = await import('../src/endpoints/settings.js'));
        ({ getUserDirectories } = await import('../src/users.js'));
    });

    beforeEach(() => {
        previousDataRoot = globalThis.DATA_ROOT;
        previousBrowserUrl = process.env.VOCALIS_BROWSER_URL;
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vocalis-settings-'));
        globalThis.DATA_ROOT = path.join(scratch, 'data');
        fs.mkdirSync(globalThis.DATA_ROOT, { recursive: true });
    });

    afterEach(() => {
        if (previousDataRoot === undefined) {
            delete globalThis.DATA_ROOT;
        } else {
            globalThis.DATA_ROOT = previousDataRoot;
        }
        if (previousBrowserUrl === undefined) {
            delete process.env.VOCALIS_BROWSER_URL;
        } else {
            process.env.VOCALIS_BROWSER_URL = previousBrowserUrl;
        }
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    afterAll(() => {
        fs.rmSync(configRoot, { recursive: true, force: true });
    });

    test('seeds only the missing URL in a fresh user settings file', async () => {
        process.env.VOCALIS_BROWSER_URL = 'https://vocalis.example.invalid:18443/';
        const originalText = fs.readFileSync(defaultSettingsPath, 'utf8');
        const original = JSON.parse(originalText);
        const directories = makeUser(originalText);
        const expected = structuredClone(original);
        expected.extension_settings.vocalis = {
            serverUrl: 'https://vocalis.example.invalid:18443',
        };

        await initializeSettings([directories]);

        const saved = JSON.parse(fs.readFileSync(path.join(directories.root, 'settings.json'), 'utf8'));
        expect(saved).toEqual(expected);
    });

    test('preserves explicit blank and custom URLs, disablement, narration, and pairing choices', async () => {
        process.env.VOCALIS_BROWSER_URL = 'https://new-instance.example.invalid';
        const blank = {
            extension_settings: {
                vocalis: { enabled: false, autoNarrate: true, serverUrl: '', pairToken: 'synthetic-token' },
            },
        };
        const custom = {
            extension_settings: {
                vocalis: { enabled: false, autoNarrate: false, serverUrl: 'https://custom.example.invalid', pairToken: '' },
            },
        };
        const disabledWithoutUrl = {
            extension_settings: {
                vocalis: { enabled: false, autoNarrate: false, pairToken: '' },
            },
        };
        const blankDirectories = makeUser(JSON.stringify(blank));
        const customDirectories = makeUser(JSON.stringify(custom));
        const disabledDirectories = makeUser(JSON.stringify(disabledWithoutUrl));

        await initializeSettings([blankDirectories, customDirectories, disabledDirectories]);
        process.env.VOCALIS_BROWSER_URL = 'https://changed-instance.example.invalid';
        await initializeSettings([blankDirectories, customDirectories, disabledDirectories]);

        expect(JSON.parse(fs.readFileSync(path.join(blankDirectories.root, 'settings.json'), 'utf8'))).toEqual(blank);
        expect(JSON.parse(fs.readFileSync(path.join(customDirectories.root, 'settings.json'), 'utf8'))).toEqual(custom);
        expect(JSON.parse(fs.readFileSync(path.join(disabledDirectories.root, 'settings.json'), 'utf8'))).toEqual({
            extension_settings: {
                vocalis: { ...disabledWithoutUrl.extension_settings.vocalis, serverUrl: 'https://new-instance.example.invalid' },
            },
        });
    });

    test('does not create missing settings or seed a URL when the instance has no URL', async () => {
        delete process.env.VOCALIS_BROWSER_URL;
        const missing = makeUser();
        const withoutUrl = { extension_settings: {} };
        const withoutUrlDirectories = makeUser(JSON.stringify(withoutUrl));
        const originalText = fs.readFileSync(path.join(withoutUrlDirectories.root, 'settings.json'), 'utf8');

        await initializeSettings([missing, withoutUrlDirectories]);

        expect(fs.existsSync(path.join(missing.root, 'settings.json'))).toBe(false);
        expect(fs.readFileSync(path.join(withoutUrlDirectories.root, 'settings.json'), 'utf8')).toBe(originalText);
    });
});
