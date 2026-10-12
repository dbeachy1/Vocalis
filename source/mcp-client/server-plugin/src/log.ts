/**
 * Downstream addition (Vocalis, October 10, 2026). NOT part of upstream Moeblack/sillytavern-mcp-client (745ff27).
 * See DOWNSTREAM-CHANGES.md at the root of this source tree.
 *
 * Why this file exists: Taproom installs a global console seam before any plugin loads, and it classifies EVERY bare
 * `console.*` line from a plugin as SENSITIVE, which a default install (`logging.debugMode: false`) suppresses. The
 * plugin's diagnostics (which server list was used, a refused stdio entry, a failed connection, how many secrets a
 * save kept) were therefore invisible, and a failed connection left no trace. Taproom's plugin context carries a
 * classified logger (`context.logger` and `context.LogClass`); a plugin uses it to vouch, line by line, that a line is
 * safe to publish. This module adopts it the way the Mnemosyne plugin does (`source/mnemosyne/src/logging.js`).
 *
 *   normal().info('server list: %d entries, %d added', total, added);        // content-free facts
 *   sensitive().debug('server list: refused %s', id);                          // anything an admin authored
 *
 * Rules, copied from the fork's own (Taproom logger section 23.5.1):
 *  - NORMAL is an assertion about the WORST possible value of every interpolated argument. Counts, durations,
 *    booleans, string literals and a class name or code that passed `safeErrorFacts` qualify. A server id, a server
 *    name, a URL, a header name or value, a handle, a path and the MESSAGE of a caught error do not (a message can carry
 *    a URL or a token, and a JSON parse error quotes the file). Those are SENSITIVE: suppressed by default, written to
 *    the debug log when the operator turns `logging.debugMode` on. Uncertainty resolves to SENSITIVE.
 *  - The class values come from the FORK's `context.LogClass`, never from constants here, so a renumbering in the fork
 *    cannot turn a SENSITIVE line into a published one.
 *  - `.bind()`, never a wrapping arrow: the fork captures the call site of a suppressed line one frame deep, and a
 *    wrapper would become that frame.
 *  - With no context (a stock SillyTavern, or a test) both channels fall back to `console.*`, which is today's
 *    behavior there.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

/** The shape of the fork's `context.logger`: each method takes the class first. */
export interface ForkLogger {
  debug(logClass: unknown, ...args: unknown[]): void;
  info(logClass: unknown, ...args: unknown[]): void;
  warn(logClass: unknown, ...args: unknown[]): void;
  error(logClass: unknown, ...args: unknown[]): void;
}

export interface ForkLogContext {
  logger?: ForkLogger;
  LogClass?: { NORMAL?: unknown; SENSITIVE?: unknown };
}

/** One classification's four methods with the class already bound. */
export interface ClassifiedSink {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The fallback: the class is accepted and discarded; the line goes to `console.*` exactly as before. */
const CONSOLE_SINK: ForkLogger = Object.freeze({
  debug: (_logClass: unknown, ...args: unknown[]) => console.debug(...args),
  info: (_logClass: unknown, ...args: unknown[]) => console.log(...args),
  warn: (_logClass: unknown, ...args: unknown[]) => console.warn(...args),
  error: (_logClass: unknown, ...args: unknown[]) => console.error(...args),
});

function bind(sink: ForkLogger, logClass: unknown): ClassifiedSink {
  const levels: Level[] = ['debug', 'info', 'warn', 'error'];
  const bound = {} as Record<Level, (...args: unknown[]) => void>;
  for (const level of levels) bound[level] = sink[level].bind(sink, logClass);
  return Object.freeze(bound);
}

let normalSink: ClassifiedSink = bind(CONSOLE_SINK, 0);
let sensitiveSink: ClassifiedSink = bind(CONSOLE_SINK, 1);

/**
 * Takes the fork's classified logger when this fork has one. Both the logger (all four methods) and both class values
 * must be present; a fork with one and not the other cannot be classified against, so we fall back.
 * @returns whether the classified channel was adopted (for the caller's own startup line)
 */
export function adoptLogger(context: ForkLogContext | null | undefined): boolean {
  const logger = context?.logger;
  const classes = context?.LogClass;
  const usable = Boolean(logger && classes)
    && typeof logger!.info === 'function'
    && typeof logger!.warn === 'function'
    && typeof logger!.error === 'function'
    && typeof logger!.debug === 'function'
    && classes!.NORMAL !== undefined
    && classes!.SENSITIVE !== undefined;
  if (!usable) return false;
  normalSink = bind(logger!, classes!.NORMAL);
  sensitiveSink = bind(logger!, classes!.SENSITIVE);
  return true;
}

/** Back to bare `console.*`. For tests only. */
export function resetLogging(): void {
  normalSink = bind(CONSOLE_SINK, 0);
  sensitiveSink = bind(CONSOLE_SINK, 1);
}

/** Lines that carry no admin-authored or user-authored value: counts, durations, booleans, literals, safe error facts. */
export function normal(): ClassifiedSink {
  return normalSink;
}

/** Lines that carry anything authored: server ids and names, URLs, header names, handles, paths, error messages. */
export function sensitive(): ClassifiedSink {
  return sensitiveSink;
}

/**
 * The only facts about a caught error that may go in a NORMAL line: its class name and its code, each only when it has
 * the shape of an identifier (a class name from code, a system error code such as ECONNREFUSED, or a number). Anything
 * else is reported as `unknown`. The MESSAGE is never included: it can carry a URL, a token or quoted file content.
 */
export function safeErrorFacts(err: unknown): { errorClass: string; errorCode: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const errorClass = typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'unknown';
  const code = (err as { code?: unknown } | null | undefined)?.code;
  const errorCode = typeof code === 'number' && Number.isFinite(code)
    ? String(code)
    : typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'none';
  return { errorClass, errorCode };
}

/** The message of a caught error, for a SENSITIVE line only. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
