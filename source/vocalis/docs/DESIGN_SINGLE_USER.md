# Vocalis is single-user by design — and multi-instance is the answer

Vocalis supports one user and one vault per instance. Additional users should run separate
instances with separate ports and credentials.

Recorded because the opposite is the natural assumption — "admin login" sounds like one account
among several — and because the cost of changing it is not obvious from the outside.

## What "single user" means concretely

One `admin_credentials.yaml`: one `username`, one `password_hash`. `login_submit` compares against
a single `ADMIN_USER` string. One vault: one DEK, one keyfile, one recovery key, shared by every
root. Anyone holding the login holds the entire store — there is no slice of it they get instead.

## Why multi-user is expensive, in order of increasing cost

Keying data by username, and freezing usernames, is the **cheapest** part. The expensive parts are
structural:

1. **One DEK is the whole encryption model.** Multi-user forces a choice, and both branches are
   bad. Share one DEK across users and encryption buys no isolation *between* users — everyone
   can decrypt everyone's audio, so the feature is theater. Give each user their own DEK and you
   need per-user keyfiles, per-user wrap/recovery/session material, and a router that knows whose
   request it is.
2. **`vault_store.route()` has no user context, anywhere.** It is a pure function of the path, and
   every seam in the app calls it — the ~40 call sites M10 just finished auditing. Per-user keys
   means threading an identity through all of them. That is the milestone that just took a full
   session to get right, done again and harder.
3. **`STORE` is a process global and the lock is global.** `_require_unlocked` is a
   `before_request` that 401s *everyone* when the vault is locked. Per-user locking means the key
   is resolved per request, and "locked" stops being a property of the server.
4. **The machine endpoints authenticate as nobody.** `/speak` and `/v1/*` are how SillyTavern and
   Nomi talk to Vocalis, and they carry no identity at all. Multi-user means per-user API tokens
   and a story for which user an inbound SillyTavern request belongs to.

## The supported answer: a second instance

The supported configuration uses separate instances on one host:

| | instance A | instance B |
|---|---|---|
| install root | `~/Vocalis` | `~/Vocalis.encrypted` |
| port | 7870 | 7871 |
| unit | `vocalis.service` | `vocalis-encrypted.service` |
| credentials, vault | its own | its own |
| cache / scratch / Applio | `vocalis.env` | `vocalis.env` |

Separate credentials, separate vaults, separate data. See DEPLOYMENT.md § "One box, two
instances" — and use `vocalis.env`, because two of the three per-instance paths default to
`$HOME`-keyed locations and collide silently otherwise.

### What a second instance does NOT isolate

Be honest about these — they are shared and they will contend:

- **ComfyUI.** A shared external service (`VOCALIS_COMFYUI_SERVICE`). Two instances driving one
  ComfyUI can interleave jobs and corrupt work.
- **The GPUs.** Both instances see the same `HIP_VISIBLE_DEVICES`. Nothing arbitrates VRAM. The
  current configuration keeps `VOCALIS_PRELOAD` absent from both units, so neither holds
  VRAM until someone renders — but two simultaneous renders still contend.
- **The Applio workspace**, unless `VOCALIS_APPLIO_DIR` differs. Cache and scratch collisions are
  caught at startup by the `.vocalis-instance` marker (`_claim_root`); **Applio has no such
  guard** and will just train both instances into one workspace.

So: two instances for two *people* is sound. Two instances rendering hard at the same time is a
resource fight nobody refereed.

## If this is ever revisited

The tractable version is not multi-user Vocalis — it is a supervisor that provisions per-user
instances (port, unit, credentials, `vocalis.env`) and reverse-proxies them. That keeps one DEK
per store and one identity per process, which is what all four costs above are really about.

## See also

- `DEPLOYMENT.md` § "One box, two instances" — the collision table and `vocalis.env`.
- `DESIGN_5_0_ENCRYPTION` §4 (key hierarchy), §7 (what is encrypted).
- `TODO_5_0_SETUP_UX` — setup.sh should detect an existing install and default the
  per-instance paths apart, which is this decision's setup-time consequence.
