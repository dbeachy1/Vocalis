// 🔴 THE DELIBERATE LIES, ALL OF THEM, IN ONE FILE. DESIGN_8_3_JSDOC_TYPES.md §3.
//
// Every declaration here widens a DOM type beyond what the browser guarantees. That is a cost, it
// is paid knowingly, and this file exists so the cost is COUNTABLE: if a type in this project is
// lying to you, it is lying here and nowhere else.
//
// ── WHY ──────────────────────────────────────────────────────────────────────────────────────
//
// Measured against `19c00bd` with `checkJs` on and `strict` off: 1,188 errors over 95 files, and
// 1,099 of them are the same thing — the app reaches for a form-control member through a
// general-purpose element type.
//
//     648 on HTMLElement     .value x307, .disabled x148, .checked x64, .files x20, .options x19
//     281 on EventTarget     e.target.dataset x93, .closest x70, .classList x21
//     170 on Element         querySelector().dataset x82, .checked x24, .value x19
//
// The honest fix is a cast at each of those ~1,100 call sites. That is the diff 8.3 exists to
// avoid — the compatibility declarations document the current browser API surface without
// changing runtime behavior.
//
// ── WHAT IS TRADED, STATED PLAINLY ───────────────────────────────────────────────────────────
//
// A human reading this codebase needs four things. This file forfeits the fourth and cheapest:
//
//   1. What does this function take and return?      -> REAL types, checked.
//   2. What is in `state` / the other stores?        -> REAL types, checked.
//   3. What does this endpoint return?               -> REAL types, checked.
//   4. Is `$('x')` an <input> or a <div>?            -> NOT checked. This file.
//
// (4) is the one a reader can answer by looking at the markup, and the only one that costs a
// thousand-site diff. What survives is still worth having: a misspelled property (`.valeu`) is still
// an error, wrong arity is still an error, and everything that is not a DOM member is fully typed.
//
// ── WHAT IS *NOT* CAUGHT, SO NOBODY IS SURPRISED ─────────────────────────────────────────────
//
// 🔴 `$('someDiv').value = 'x'` type-checks and is wrong at runtime. So does `xhr.dataset`.
// EventTarget is implemented by `window`, `XMLHttpRequest`, `WebSocket` and `EventSource` as well
// as by elements, and this file tells the checker all of them have `.dataset`. Nothing in the tree
// does that today; the point is that the checker would no longer stop it.
//
// ── THE EXIT ─────────────────────────────────────────────────────────────────────────────────
//
// Deleting this file is a milestone of its own: turn each declaration off, take the errors, and
// convert the call sites to real casts a directory at a time. It is ~1,100 edits, it is mechanical,
// and it is a BEHAVIOR-NEUTRAL change that still deserves its own testing.
//
// ⚠️ NOTHING NEW GOES IN HERE WITHOUT THAT ARGUMENT BEING MADE AGAIN. A permissive-types file that
// grows whenever a run goes red stops being a recorded trade and becomes the type system quietly
// switched off. tests/test_webui_types.py pins the count of declarations below.

declare global {
    /**
     * What `$()` and `wbEl()` are treated as everywhere in this app: an element that supports every
     * member the tree ever asks of one.
     *
     * 🔴 AN EXPLICIT MEMBER LIST, NOT AN INTERSECTION OF THE REAL DOM INTERFACES — and the first
     * attempt WAS that intersection, which is instructive. `HTMLElement & HTMLInputElement &
     * HTMLSelectElement & HTMLTextAreaElement & HTMLButtonElement & HTMLMediaElement` reduces to
     * **`never`**, because `HTMLSelectElement.type` is `"select-one" | "select-multiple"` and
     * `HTMLTextAreaElement.type` is `"textarea"` — disjoint literal unions, so TypeScript collapses
     * the whole intersection. Error count went 297 → 2,068, every one of them "does not exist on
     * type 'never'". An intersection of real DOM interfaces is not a tool that works here.
     *
     * ✅ AND THE REPLACEMENT IS BETTER THAN THE THING IT REPLACES. Listing the members explicitly
     * means this type is a MEASURED INVENTORY of how the app touches the DOM, so the widening is
     * bounded by what the code actually does rather than by what six interfaces happen to contain.
     * Every entry below was put here by a real error, never pre-emptively.
     *
     * ✅ GLOBAL ON PURPOSE. `$()` has 1,387 call sites and `wbEl()` another 198; making this
     * importable rather than ambient would put
     * `import('../../../../types/dom-permissive.js').VEl` in every annotation that touches an
     * element. An ambient name is the difference between an annotation someone will write and one
     * they will skip.
     */
    interface VEl extends HTMLElement {
        // ✅ EMPTY SINCE 8.8-m9. This interface used to declare 28 members that `HTMLElement` does
        // not have — `.value`, `.checked`, `.disabled`, `.files`, `.play()` and the rest — so that
        // `$('someInput').value` would compile without saying which kind of element it is. That was
        // the second of the two lies DESIGN_8_3 §3 recorded, and §3.1(c) named removing it as its
        // own milestone. 624 call sites now state the real element type instead.
        //
        // ✅ AND THE OTHER LIE IS GONE TOO, SINCE 8.8-m10. This note used to read "ONE LIE
        // REMAINS: `$()` still returns VEl rather than `VEl | null`" and called it 1480 sites and
        // a deliberate choice. Assert by default, since a cast is a comment and two parens,
        // while a guard would have added runtime branches — and `$`/`wbEl` return
        // `VEl | null` now. NOTHING IN THIS FILE, OR IN THE TREE, LIES TO THE CHECKER.
        //
        // 🔴 WHICH MAKES THE BASE TYPE THE ONLY WAY BACK IN, AND IT IS ONE WORD WIDE.
        // `interface VEl extends HTMLInputElement {}` restores `.value`, `.checked`, `.files` and
        // `.disabled` on every `$()` result, and every counting gate STAYS GREEN because a
        // widening removes errors. `test_the_widening_cannot_come_back_through_the_BASE_TYPE`
        // pins this line for exactly that reason — do not change what it extends.
        //
        // 📌 The interface is kept rather than replaced with a `type VEl = HTMLElement` alias so
        // that the ~1400 references to `VEl` need not all change at once. That alias form is
        // pinned too, by PERMISSIVE_SHAPE, since it would sidestep the interface scan entirely.

    }

}

// The file must be a module for `declare global` to be an AUGMENTATION rather than a
// REPLACEMENT of the global scope. Nothing is actually exported - `VEl` is ambient above.
export {};
