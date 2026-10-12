/**
 * Express, as Mnemosyne is allowed to see it — and no more than that.
 *
 * 🔴 **HAND-WRITTEN, AND NOT `@types/express`, ON PURPOSE.** Two reasons, and the second is the one that
 * decides it.
 *
 * First, Mnemosyne does not depend on Express and must not start. It never imports it, never instantiates
 * one, and never mounts anything: the fork constructs the router, applies its own auth middleware, and hands
 * the router to `init` already mounted at `/api/plugins/mnemosyne`. Adding `@types/express` would put eight
 * packages (`@types/qs`, `@types/serve-static`, `@types/body-parser`, `@types/connect`, …) into a repository
 * whose `tests/dependencies.test.js` exists to make anyone adding a package argue for it out loud. They are
 * dev-only and would never run beside the key, so this is a preference rather than the security rule — but it
 * is the same instinct, and the instinct is right.
 *
 * 🔴 Second and decisively: **the real thing is not stock Express anyway.** `req.user` does not exist in
 * Express. It is put there by the fork's `setUserDataMiddleware`, and `req.user.profile.handle` is the entire
 * authentication story for every route in `src/api/` — it is what makes a memory id in a URL safe, because an
 * id can only ever address the caller's own store (`api/request.js`). With `@types/express` that field would
 * need a module augmentation *anyway*, and the augmentation would be this file with a dependency attached.
 * Declaring the surface we actually touch, in one file, next to the reason, is the honest version.
 *
 * ⚠️ **THIS IS A DECLARATION OF WHAT WE CALL, NOT A PROMISE ABOUT WHAT EXPRESS DOES.** Everything below is
 * narrowed to the members `src/api/` reaches for. If a route needs another one, add it here with a line
 * saying what it is for — never widen an existing member to make an error go away, because the whole value of
 * a hand-written stub is that it cannot quietly become `any`.
 */
declare module 'express' {
    /**
     * The authenticated caller, as the fork's `setUserDataMiddleware` leaves it.
     *
     * 🔴 Optional at every level, and that is not defensive noise. `requireLoginMiddleware` should make it
     * present on every route in this plugin — but "should" is a claim about somebody else's middleware order,
     * and `storeForRequest` answers 401 rather than guessing a user when it is absent. The optionality here is
     * what forces that check to stay written.
     */
    interface RequestUser {
        profile?: {
            handle?: string;
            /**
             * Whether this caller administers the install — the fork sets it on the same profile object
             * (`src/users.js`, which gates its own routes on `request.user.profile.admin`).
             *
             * Read in exactly one place: the panel's log view. The log tape is process-global, so it
             * interleaves every account on the install and cannot be filtered per user — see `renderLog`.
             * Optional like `handle`, and for the same reason: a fork that does not set it reads as
             * not-an-admin, which is the safe direction for a gate.
             */
            admin?: boolean;
        };
    }

    interface Request {
        /** 🔴 The authenticated caller — never the request body. See `api/request.js`. */
        user?: RequestUser;

        /**
         * Parsed query string. Values are `unknown` because they are: Express hands back a string, an array of
         * strings, or a nested object depending on what the client sent, and every reader in `api/request.js`
         * already proves `typeof value === 'string'` before using one. Typing this as `string` would delete
         * exactly the check that stops `?limit[]=1&limit[]=2` reaching a SQL `LIMIT`.
         */
        query?: Record<string, unknown>;

        /**
         * The JSON body, when the host's `bodyParser.json` parsed one.
         *
         * ⚠️ A JSON body need not be an object — `"hello"` and `[1,2]` are valid JSON documents, and this
         * declaration describes the object case because that is the only case any route acts on. Indexing a
         * string or an array by a parameter name yields `undefined` at runtime, which is what the readers
         * treat as absent, so the two agree in practice.
         */
        body?: Record<string, unknown>;

        /** Route parameters — `/memory/:id`. Strings or absent; never trusted without parsing. */
        params?: Record<string, string>;

        /**
         * Content negotiation. 🔴 Returns the FIRST listed type when the client sent no `Accept` header, which
         * is why `wantsFragment` lists `json` first — see the argument there. `false` when nothing matches.
         */
        accepts?(types: string[]): string | false;
    }

    interface Response {
        /** Chainable, which is how every refusal in `api/` is written: `res.status(409).json({ error })`. */
        status(code: number): Response;
        json(body: unknown): Response;
        set(field: string, value: string): Response;
        send(body?: unknown): Response;
        end(chunk?: unknown): Response;
    }

    /** The fork's `next`. Mnemosyne never calls it — its handlers are terminal — but the shape is part of one. */
    type NextFunction = (err?: unknown) => void;

    type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;

    /**
     * The router the fork hands `init`, already mounted and already behind its auth middleware.
     *
     * Only the four verbs `src/api/routes.js` mounts. `use`, `all`, `param` and the rest are deliberately
     * absent: a plugin that starts adding middleware to a router the host configured is a plugin reaching
     * outside its contract, and leaving them undeclared makes that show up here rather than in production.
     */
    interface Router {
        get(path: string, handler: RequestHandler): Router;
        post(path: string, handler: RequestHandler): Router;
        put(path: string, handler: RequestHandler): Router;
        delete(path: string, handler: RequestHandler): Router;
    }
}
