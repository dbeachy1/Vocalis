/**
 * What a test still has to reset — which is now almost nothing, and that is the point.
 *
 * 🔴 THIS FILE USED TO GATHER FOUR RESET HOOKS. IT GATHERS ONE.
 *
 * Before `vault-state.js`, every provider in a process shared six mutable module globals: the data root,
 * the unlocked key table, the known handles, the foreign-store registry, the name-scheme cache and the
 * pending recovery keys. A test could not get a clean provider by asking for one, so each module grew a
 * `reset*()` exported for tests and nothing else, and every test file had to know which subset applied
 * to it — `log-classification.test.js` reset three, `provider.test.js` a different three.
 *
 * **The way to get a clean vault now is to build one.** `createVaultProvider()` is a real factory: its
 * state is created per call and reachable from nowhere else. Two providers in one process share nothing.
 *
 *     const provider = createVaultProvider();   // this IS the reset
 *
 * ## ⚠️ The one thing that is still global, and why it should be
 *
 * `logging.js` holds the log sinks at module scope, deliberately. The fork hands ONE logger to the
 * process, at boot, in the storage-provider context — it is a property of the process, not of a provider,
 * and a second provider does not get a second logger to adopt. Making it per-instance would invent an
 * ownership that does not exist and let two providers disagree about where warnings go.
 *
 * So `resetLogging()` remains, and remains necessary: a test that adopts a recording logger has changed
 * something the next test will otherwise inherit.
 *
 * ## 🔴 And one that is NOT a reset, however much it looks like one
 *
 * `session.closeAll(vault)` is re-exported here because tests want it, but it is **not** bookkeeping. It
 * zeroes the DEK and every subkey. Dropping a provider does not do that — the buffers survive in the heap
 * until the collector reaches them, which is the exact window `session.close` exists to close. A test that
 * abandons an unlocked provider leaves live key material in the process, and so would production code.
 * **Shutting a vault down means calling this.**
 */

import { resetLogging } from './logging.js';
import { closeAll } from './session.js';

export { resetLogging, closeAll };
