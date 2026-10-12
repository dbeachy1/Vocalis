import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, test, expect } from '@jest/globals';

const require = createRequire(import.meta.url);
const espree = require('espree');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const worldInfoPath = path.join(repoRoot, 'public', 'scripts', 'world-info.js');
const indexPath = path.join(repoRoot, 'public', 'index.html');
const source = fs.readFileSync(worldInfoPath, 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });

/**
 * 🔴 A NEW WORLD INFO ENTRY MUST DEFAULT TO `@ D`, NOT TO `Before Char Defs`.
 *
 * Upstream's default is `position: 0` — Before Char Defs — which lands every new entry in the first few
 * thousand tokens of the assembled prompt, above the chat history. That is the worst available place for
 * a *conditional* entry, and the reason is arithmetic, not taste:
 *
 *   - A KV cache reuses tokens only up to the FIRST BYTE THAT DIFFERS. Everything after a change is
 *     recomputed, so the COST OF A CHANGE IS ITS POSITION, not its size.
 *   - A conditional entry fires on some turns and not others, so the block it sits in is a different
 *     length every turn — which moves every entry below it to a new offset.
 *   - Measured against the live model (GLM-Steam-106B-A12B IQ4_XS, 38,912-token window, f16 KV, flash
 *     attention): twelve changed tokens at the TOP cost 95.4 s. The identical prompt re-sent cost 0.22 s.
 *     ~1,000 tokens inserted near the END cost 10.2 s. Real chats were taking 133 s per turn, of which
 *     ~113 s was reprocessing the ~36,700 tokens sitting below a World Info block that moved every turn.
 *
 * ⚠️ CONSTANT (BLUE) ENTRIES ARE NOT THE PROBLEM and this default is not aimed at them. They are always
 * present and always identical, so the prefix through them is stable and free after the first turn. The
 * damage comes from conditional entries INTERLEAVED into that block: when one fires it shifts the
 * constant ones to new offsets and invalidates those too. It is the assembled block that has to be
 * byte-stable, never the individual entry. A new entry is conditional until the user makes it constant,
 * so the safe default for a new entry is the one that keeps it out of the stable region entirely.
 *
 * 🔴 THIS SUITE IS AIMED AT AN UPSTREAM MERGE, NOT AT A DEVELOPER. `default: 0` is one token inside a
 * forty-property object literal, in a file this fork does not otherwise own; a merge that restored it
 * would surface nowhere except as chats gradually going slow again — the same shape of failure as the
 * embedding default that shipped meaningless vectors for twenty months (`tests/embedder-sanity.test.js`).
 * Nothing else in the suite reads this value.
 *
 * 📌 WHY A DEFAULT AND NOT A SETTING. A setting needs a persisted key, markup in the World Info drawer,
 * and a migration — a strictly LARGER surface in the same two files, so strictly more to reconcile on
 * each upstream pull, not less. The escape hatch already exists and costs one dropdown click on the
 * entry itself.
 *
 * ⚠️ EXISTING ENTRIES ARE NEVER RELOCATED. This is the default for entries that do not exist yet.
 * Rewriting a book the user already wrote is worse than the bug, and it has its own explicit,
 * previewable path outside SillyTavern (export → transform → import).
 */
describe('World info: where a new entry starts', () => {
    /**
     * Depth-first walk over the ESTree AST.
     * @param {object} node Node to start from
     * @param {(node: object) => void} visit Called for every node
     */
    function walk(node, visit) {
        if (!node || typeof node.type !== 'string') {
            return;
        }

        visit(node);

        for (const key of Object.keys(node)) {
            if (key === 'range' || key === 'loc') {
                continue;
            }

            const value = node[key];

            if (Array.isArray(value)) {
                value.forEach(child => walk(child, visit));
            } else if (value && typeof value.type === 'string') {
                walk(value, visit);
            }
        }
    }

    /**
     * The initialiser of a top-level `export const <name> = ...`.
     * @param {string} name Declared name
     * @returns {object} The init node
     */
    function exportedConst(name) {
        let found = null;

        walk(ast, node => {
            if (node.type !== 'VariableDeclarator' || node.id?.name !== name) {
                return;
            }

            found = node.init;
        });

        expect(found).not.toBeNull();
        return found;
    }

    /**
     * A property of an object literal, by key.
     * @param {object} objectExpression The ObjectExpression node
     * @param {string} key Property name
     * @returns {object|null} The property value node, or null when absent
     */
    function property(objectExpression, key) {
        const match = objectExpression.properties.find(p => p.type === 'Property' && p.key?.name === key);
        return match ? match.value : null;
    }

    /**
     * The object literal a converter builds each imported entry from — identified by its spread of
     * `newWorldInfoEntryTemplate`, so this keeps working if the surrounding function is reshaped.
     * @param {string} functionName The converter name
     * @returns {object} The ObjectExpression node
     */
    function importedEntryLiteral(functionName) {
        let declaration = null;

        walk(ast, node => {
            if (node.type !== 'FunctionDeclaration' || node.id?.name !== functionName) {
                return;
            }

            declaration = node;
        });

        expect(declaration).not.toBeNull();

        const literals = [];

        walk(declaration, node => {
            if (node.type !== 'ObjectExpression') {
                return;
            }

            const spreadsTemplate = node.properties.some(p =>
                p.type === 'SpreadElement' && p.argument?.name === 'newWorldInfoEntryTemplate');

            if (spreadsTemplate) {
                literals.push(node);
            }
        });

        expect(literals).toHaveLength(1);
        return literals[0];
    }

    /**
     * Asserts a node is exactly `world_info_position.<member>`.
     * @param {object} node The value node
     * @param {string} member Expected member name
     */
    function expectPositionEnum(node, member) {
        expect(node?.type).toBe('MemberExpression');
        expect(node.object?.name).toBe('world_info_position');
        expect(node.property?.name).toBe(member);
    }

    /** The `world_info_position` enum, resolved to its numbers. */
    const positions = Object.fromEntries(
        exportedConst('world_info_position').properties.map(p => [p.key.name, p.value.value]),
    );

    test('the position enum still means what the rest of this suite assumes', () => {
        // Both halves matter: `before` is the value being moved away from, `atDepth` the one being moved
        // to. `atDepth` reading as literal 4 is also a documented trap — an entry `depth` field is
        // consulted ONLY when position === 4, so "depth 4, order 89" shown on an entry positioned Before
        // Char Defs is using neither field. That misreading cost an hour during the diagnosis.
        expect(positions.before).toBe(0);
        expect(positions.atDepth).toBe(4);
    });

    test('a newly created entry defaults to at-depth', () => {
        const definition = exportedConst('newWorldInfoEntryDefinition');
        const position = property(definition, 'position');

        expect(position).not.toBeNull();
        expectPositionEnum(property(position, 'default'), 'atDepth');
    });

    test('a newly created entry carries a depth for that position to use', () => {
        // Shape, not value: which depth is a tuning decision. That there IS one is not — position 4 with
        // no depth is an entry the prompt builder cannot place.
        const definition = exportedConst('newWorldInfoEntryDefinition');
        const depth = property(definition, 'depth');

        expect(depth).not.toBeNull();
        expect(property(depth, 'default')?.name).toBe('DEFAULT_DEPTH');

        const defaultDepth = exportedConst('DEFAULT_DEPTH');
        expect(Number.isInteger(defaultDepth.value)).toBe(true);
        expect(defaultDepth.value).toBeGreaterThanOrEqual(0);
    });

    // These three formats carry no position concept, so the importer has always been choosing one on the
    // user's behalf. Choosing `before` is how an imported book arrives pre-broken; an imported entry is a
    // created entry, and gets the same default as one typed by hand.
    //
    // ⚠️ A loop rather than `test.each`, which `playwright/no-standalone-expect` does not recognise as a
    // test block — every `test.each` shape trips it, measured. `tests/` is outside `npm run lint`, so the
    // error would have been invisible; that is a reason to keep the file clean, not to leave it dirty.
    for (const functionName of ['convertAgnaiMemoryBook', 'convertRisuLorebook', 'convertNovelLorebook']) {
        test(`${functionName} invents at-depth, because its source format has no position at all`, () => {
            const literal = importedEntryLiteral(functionName);

            expectPositionEnum(property(literal, 'position'), 'atDepth');
            expect(property(literal, 'depth')?.name).toBe('DEFAULT_DEPTH');
        });
    }

    test('convertCharacterBook still reads position from the card, and is not to be flipped', () => {
        // 🔴 THE ODD ONE OUT, DELIBERATELY. A V2 character book DOES carry a position — `before_char` /
        // `after_char`, plus an `extensions.position` — so here there is a real value to honour, and
        // overriding it would be import corruption rather than a default. Left alone on purpose; this
        // assertion exists so that "flip every hardcoded position" cannot later sweep it up.
        const literal = importedEntryLiteral('convertCharacterBook');
        const position = property(literal, 'position');

        expect(position).not.toBeNull();
        expect(source.slice(position.range[0], position.range[1])).toMatch(/\bentry\b/);
    });

    test('🔴 no world book we SHIP puts a conditional entry above the chat history', () => {
        // Conditional entries above chat history change the prompt prefix between turns. Constant
        // entries are allowed there because their content does not change.
        const findOffenders = (book) => Object.entries(book.entries ?? {})
            .filter(([, entry]) => !(entry.constant ?? false) && (entry.position === 0 || entry.position === 1))
            .map(([id, entry]) => `${book.name} uid ${entry.uid ?? id}`);

        expect(findOffenders({
            name: 'synthetic book',
            entries: { conditional: { uid: 1, position: 0, constant: false } },
        })).toEqual(['synthetic book uid 1']);
        expect(findOffenders({
            name: 'synthetic book',
            entries: { constant: { uid: 2, position: 1, constant: true } },
        })).toEqual([]);

        const contentDirectory = path.join(repoRoot, 'default', 'content');
        const index = JSON.parse(fs.readFileSync(path.join(contentDirectory, 'index.json'), 'utf8'));
        const indexedWorlds = index.filter(entry => entry.type === 'world');

        for (const world of indexedWorlds) {
            expect(fs.existsSync(path.join(contentDirectory, world.filename))).toBe(true);
        }

        const books = fs.readdirSync(contentDirectory)
            .filter(name => name.endsWith('.json') && name !== 'index.json')
            .map(name => ({ name, json: JSON.parse(fs.readFileSync(path.join(contentDirectory, name), 'utf8')) }))
            .filter(book => book.json && typeof book.json.entries === 'object');

        const offenders = books.flatMap(book => findOffenders({
            name: book.name,
            entries: book.json.entries,
        }));

        expect(offenders).toEqual([]);
    });

    test('the position dropdown can actually display the default', () => {
        // The select pairs `value` with `data-role`, and the renderer looks for BOTH:
        //     option[value="${entry.position}"][data-role="${roleValue}"]
        // where roleValue is the role for an at-depth entry and empty for every other position. Miss that
        // pairing and a new entry renders with nothing selected — the default correct in the data and
        // invisible in the UI.
        const index = fs.readFileSync(indexPath, 'utf8');
        const select = index.match(/<select name="position"[\s\S]*?<\/select>/);

        expect(select).not.toBeNull();

        const definition = exportedConst('newWorldInfoEntryDefinition');
        const defaultPosition = positions[property(property(definition, 'position'), 'default').property.name];
        const defaultRole = property(property(definition, 'role'), 'default').value;

        expect(select[0]).toContain(`<option value="${defaultPosition}" data-role="${defaultRole}"`);
    });
});
