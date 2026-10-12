/**
 * Two places where TypeScript's own `lib` under-describes a built-in, and this project pays for it in casts.
 *
 * 🔴 **AN AUGMENTATION IS ONLY LEGITIMATE WHEN IT MAKES A TRUE STATEMENT THE STOCK DECLARATION FAILED TO
 * MAKE.** That is the whole test, and it is a narrow one. Widening a built-in to get past an error is the
 * suppression this milestone exists to refuse — it just wears a `.d.ts` extension. Each entry below has to
 * be readable as: *the runtime already guarantees this, and the declaration simply does not say so.*
 *
 * ⚠️ Nothing here may ever be used to make a call site compile that would fail at runtime. If an augmentation
 * cannot be justified against the ECMAScript specification, it does not belong in this file.
 */

interface NumberConstructor {
    /**
     * `Number.isInteger` as a TYPE PREDICATE, which is what it has always been at runtime.
     *
     * `lib.es2015.core.d.ts` declares it `isInteger(number: unknown): boolean`. That is not wrong, it is
     * merely silent: ECMAScript §21.1.2.3 returns `true` only when the argument *is* a Number and has no
     * fractional part, so a `true` result proves `number` exactly as much as `typeof x === 'number'` does.
     * The stock declaration throws that proof away, and the value reads as possibly-absent again on the very
     * next line.
     *
     * 🔴 **The point is that it deletes casts rather than adding one.** Four sites in `retrieval.js`
     * (`anchorFor`, `injectInto`) guarded with `Number.isInteger(...)` and then had to restate the guard as
     * `/** @type {number} *\/`. A cast is a promise; this is a proof — and a proof cannot drift away from the
     * guard it belongs to, which is exactly how a cast goes wrong.
     *
     * ⚠️ It narrows to `number`, NOT to some integer type — TypeScript has no such type. `1.5` is excluded at
     * runtime and indistinguishable from `1` here. Anything relying on integrality still has to say so.
     */
    isInteger(value: unknown): value is number;

    /**
     * `Number.isFinite`, for the same reason and on the same authority.
     *
     * ECMAScript §21.1.2.2: `false` unless the argument is a Number that is neither `NaN` nor an infinity. So
     * `true` proves `number`, and `lib`'s `isFinite(number: unknown): boolean` again declines to say it.
     *
     * ⚠️ Not to be confused with the GLOBAL `isFinite`, which coerces — `isFinite('42')` is `true` and proves
     * nothing at all. That one is correctly declared as returning `boolean` and must stay that way.
     */
    isFinite(value: unknown): value is number;
}
