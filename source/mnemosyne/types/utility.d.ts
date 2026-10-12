/**
 * One utility type, for one problem that took a probe file to believe.
 *
 * 🔴 `Object.freeze` ON AN OBJECT LITERAL PRESERVES LITERAL TYPES, AND THAT TURNS AN OVERRIDABLE DEFAULT INTO
 * A CONSTANT NOBODY CAN OVERRIDE.
 *
 * `config.js` exports `INGEST_DEFAULTS = Object.freeze({ windowContextTail: 4, confirmUncertain: true, … })`.
 * Freezing hits `ObjectConstructor.freeze`'s primitive-constrained overload, so `typeof INGEST_DEFAULTS` is
 * not `{ windowContextTail: number }` — it is `Readonly<{ windowContextTail: 4, confirmUncertain: true, … }>`,
 * where `4` and `true` are the *literal* types.
 *
 * Four functions took `@param {typeof INGEST_DEFAULTS} defaults`, and that parameter exists precisely so a
 * caller can hand over a modified copy. It accepted only the exact frozen values. `{ ...INGEST_DEFAULTS,
 * windowContextTail: 0 }` is `Type '0' is not assignable to type '4'` — **the parameter whose entire purpose
 * is overriding a default rejected every override.**
 *
 * ⚠️ **AND `src/` COULD NOT SEE IT.** Nothing in `src/` ever overrides one; the defaults object is passed
 * through whole. Only `tests/` exercises the injection seam, so the four annotations type-checked clean for as
 * long as the only thing checking them was the code that never used the feature. It surfaced the moment
 * `tests/` came under the checker — which is the argument for this milestone in one defect.
 */

/**
 * Widen literal primitive types back to their base types, one level deep.
 *
 * `Widen<Readonly<{ a: 4, b: true }>>` is `{ readonly a: number, readonly b: boolean }`. Non-primitive
 * properties — arrays, nested objects — are passed through untouched, deliberately: widening those would need
 * a recursive walk, and nothing here has one that needs it. If a nested object ever gains a literal that needs
 * overriding, make THAT explicit rather than making this clever.
 *
 * ⚠️ The `readonly` modifiers are kept rather than stripped. TypeScript does not enforce property-`readonly`
 * in assignability, so a fresh mutable object literal satisfies this and so does the frozen original; removing
 * them would buy nothing and would quietly claim the caller may mutate what it was handed.
 */
type Widen<T> = {
    [K in keyof T]: T[K] extends boolean ? boolean
        : T[K] extends number ? number
            : T[K] extends string ? string
                : T[K];
};
