// Collects the license and notice files of the npm packages a built project actually ships (its non-dev closure per
// package-lock.json) into one folder, plus an index. Used by the Taproom image build for the MCP client plugin, whose
// bundle (plugin/index.bundle.js) inlines @modelcontextprotocol/sdk, zod and their dependencies: a bundle drops the
// packages' own files, so their MIT/ISC/BSD notices are carried beside the image's other licenses instead.
//
// Usage: node collect-npm-notices.mjs <projectDir> <outDir>
//   projectDir  has package-lock.json and an installed node_modules (npm ci)
//   outDir      is created; one folder per package <name>@<version>, plus index.json
//
// The set is a superset of what the bundle inlines (it also lists packages left external, such as express, which
// Taproom provides). Dev-only packages (the build tools) are not shipped and are skipped. A package with no license
// file is listed in the index with missingLicenseFile true and named on stdout; its license field is still recorded.
import fs from 'node:fs';
import path from 'node:path';

const [projectDir, outDir] = process.argv.slice(2);
if (!projectDir || !outDir) {
    console.error('usage: node collect-npm-notices.mjs <projectDir> <outDir>');
    process.exit(2);
}

const NOTICE_FILE = /^(licen[cs]e|notice|copying)([-._].*)?$/i;
const lock = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const index = [];
let skippedDev = 0;
let notInstalled = 0;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    if (entry.dev || entry.devOptional) { skippedDev += 1; continue; }
    const dir = path.join(projectDir, key);
    if (!fs.existsSync(dir)) { notInstalled += 1; continue; }
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const target = path.join(outDir, `${name.replace(/\//g, '__')}@${entry.version}`);
    const copied = [];
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !NOTICE_FILE.test(file.name)) continue;
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(path.join(dir, file.name), path.join(target, file.name));
        copied.push(file.name);
    }
    index.push({ name, version: entry.version, license: entry.license ?? null, files: copied, missingLicenseFile: copied.length === 0 });
}

index.sort((a, b) => (a.name + a.version).localeCompare(b.name + b.version));
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
const missing = index.filter((item) => item.missingLicenseFile);
console.log(`collect-npm-notices: ${index.length} shipped package(s), ${index.length - missing.length} with notice files, `
    + `${missing.length} without (${missing.map((item) => `${item.name}@${item.version} [${item.license ?? 'no license field'}]`).join(', ') || 'none'}); `
    + `${skippedDev} dev-only skipped, ${notInstalled} not installed on this platform`);
