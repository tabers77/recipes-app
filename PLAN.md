# Recipes App — Implementation Plan

**Created:** 2026-09-05
**Goal:** A phone-usable app for my own cooking recipes: create, edit, delete,
organise by category, attach link references. Works in a kitchen with bad wifi.
Recipes live in a file I own, in my own Google Drive.

---

## 1. Decisions locked

| Decision | Choice | Consequence |
|---|---|---|
| Source of truth on device | **IndexedDB** | Every edit is instant and works fully offline. Sync is never in the path of a user action. |
| Durable store | **Google Drive**, one `recipes.json` in a visible `Recipes/` folder | The data is a file I own and can back up. Not a database — Drive has no queries and no partial writes, so it is a sync target only. |
| Scope | **`drive.file`** | Narrowest possible: the app can only touch files it created. Keeps the folder visible in Drive (unlike `appDataFolder`) and avoids the review that `drive`/`drive.readonly` trigger. |
| Conflict resolution | **Last-write-wins per recipe on `updatedAt`**, plus tombstones | Single user, so no CRDT is warranted. A tombstone always beats an older edit, so a delete on one device is not resurrected by the other. |
| Deletes | **Soft**, `deletedAt` set, purged after 90 days | A hard delete cannot be synced — the other device would just re-add the record. |
| Photos | **Not in v1** | Cuts binary upload, compression, quota and offline-binary handling out of every phase. See §7. |
| Framework | **None.** No build step, no dependencies | Same discipline as the vault quiz app this borrows from. The whole app is static files. |
| Hosting | **Cloudflare Pages** + the password-gate worker | Free tier. Worker copied verbatim from the quiz app. |

### Explicitly rejected

- **Cloudflare Zero Trust / Access.** Requires a card on file *and* a standing
  charge authorization before it can be enabled at all, even on the free plan.
  This was hit and declined on the quiz app. `_worker.js` is the replacement.
- **Cloudflare D1 as the store.** Simpler than Drive — no OAuth, sync is one
  `fetch` — but the recipes would live in Cloudflare rather than in a file I
  own. Owning the file was the point.
- **A client-side password check.** Ships the content before it checks. That is
  decoration, not protection.

---

## 2. Architecture

```
Phone / laptop PWA
  IndexedDB  <-- source of truth, all CRUD is instant and offline
      |
      |  sync engine (on open, on save, on reconnect)  -- Phase 4
      v
Google Drive   "Recipes/" folder, created by the app
      recipes.json
```

Everything the user does writes to IndexedDB and returns immediately. Sync is a
background reconcile with a "last synced" line in the header. This is what makes
it usable on one bar of signal.

---

## 3. Data model

One JSON array, deliberately flat. Categories are **free-form tags**, not a
fixed tree — a new category never requires a migration.

```jsonc
{
  "schemaVersion": 1,
  "recipes": [{
    "id": "r_8f3a1c9d",                  // client-generated, never reused
    "title": "Carbonara",
    "categories": ["Pasta", "Quick"],
    "servings": 2,
    "timeMinutes": 25,
    "ingredients": ["200g guanciale", "3 egg yolks"],
    "steps": ["Render the guanciale.", "Off the heat, fold in the eggs."],
    "links": [{ "url": "https://...", "label": "Original video" }],
    "notes": "Use less salt than it says.",
    "imageIds": [],                      // reserved for Phase 5
    "createdAt": "2026-09-05T18:00:00.000Z",
    "updatedAt": "2026-09-05T18:00:00.000Z",
    "deletedAt": null                    // tombstone
  }]
}
```

The same record shape is used in IndexedDB and in the Drive file. No mapping
layer, no second schema to keep in step.

---

## 4. Sync engine (Phase 4)

```
on open / on save / on reconnect:
  1. no token -> requestAccessToken({ prompt: '' })   // silent; falls back to a tap
  2. GET file metadata -> headRevisionId
  3. headRevisionId unchanged -> local is ahead, push only
  4. changed -> pull remote, merge per recipe:
        later updatedAt wins
        a tombstone always beats an older edit
  5. push merged set, store the new headRevisionId
```

`syncMeta` already exists as an object store from Phase 1, so Phase 4 needs no
IndexedDB version bump.

---

## 5. Phasing

| Phase | Deliverable | Usable? |
|---|---|---|
| **1** | IndexedDB CRUD, category filter, search, link refs, JSON export/import | Yes, on the laptop |
| **2** | PWA: service worker, manifest, icons, update prompt | Yes, offline |
| **3** | Cloudflare Pages project, password gate, CI deploy | Yes, from anywhere |
| **4** | Google Drive sync | Multi-device |
| 5 | Photos, import-from-URL, export to Markdown | — |

Sync is deliberately last. The schema will churn during Phase 1, and each change
is free until sync exists to constrain it.

**Phase 2 notes.** One cache, cache-first, versioned by `SHELL_VERSION` -- there
is no data file to keep fresh, because the recipes live in IndexedDB and the
service worker never touches it. Two things were carried over from the vault
quiz app rather than rediscovered:

- Precache `'./'`, never `'./index.html'`. Pages 308s one to the other, and a
  cached redirected response cannot answer a navigation at all.
- Reject HTML served where a script, stylesheet or icon was requested. From
  Phase 3 the password gate answers an expired session with 200 + a login page,
  and caching that would pin the login screen in place of the app.

`SHELL_VERSION` is hand-edited until Phase 3 stamps it in CI. Forgetting to bump
it is the one way to leave a phone on stale code silently, so Phase 3 must also
add a check that fails the deploy if it was not stamped.

**Phase 3 notes.** `_worker.js` is the vault quiz app's gate with the cookie
renamed. The service worker gained `isAuthChallenge()` at the same time, and
that closes a real hole: `isLoginPage()` only inspects file extensions, so a
login page served at the app root -- where it and the real app are both
`text/html` -- would have been precached **as the app shell**, leaving the app
gone until site data was cleared. The gate now stamps `x-recipes-auth: required`
on every challenge and the service worker refuses to cache anything carrying it.

The password is a Pages environment variable, never a GitHub secret: it belongs
to the running worker, not to the build, and nothing in CI should see it. The
consequence is that the first deploy answers 500 until it is set -- the
fail-closed rule working as intended, not a broken deploy.

**Phase 4 notes.** Built as specified in section 4, with three decisions that
were not obvious until the code existed:

1. **A read only happens when the revision moved.** Binding stores the revision;
   an unchanged one means nobody else wrote and the whole download is skipped.
2. **The merge is applied locally before the push.** If the upload then fails,
   the device keeps everything it learned and the next sync retries. Applying it
   after would throw away a successful pull on a failed push.
3. **On an exact `updatedAt` tie the tombstone wins.** A tie means the two edits
   cannot be ordered; re-deleting is recoverable from a backup, a silent
   resurrection is not.

The residual race is stated rather than papered over: Drive has no
compare-and-swap on upload, so the engine re-checks the revision immediately
before writing and aborts if it moved. That narrows the window to the round trip
itself and needs simultaneous edits on two devices to lose, with the loser's
change still sitting in its own IndexedDB.

**Why export/import is in Phase 1 and not Phase 5:** between Phase 1 and Phase 4
the only copy of the data is IndexedDB in one browser profile. Clearing site
data would destroy it. Export is the stopgap backup until Drive sync lands.

---

## 6. Cost

Every service is free at this scale.

| Service | Cost | Why |
|---|---|---|
| Google Cloud project + Drive API | £0 | Drive API needs no billing account |
| OAuth consent screen | £0 | `drive.file` is non-sensitive; no paid verification |
| Google Drive storage | £0 | Existing 15 GB; `recipes.json` is a few hundred KB |
| Cloudflare Pages | £0 | Unlimited static bandwidth |
| Pages Functions (`_worker.js`) | £0 | Free tier far above one personal app |
| GitHub private repo + Actions | £0 | ~1 minute per deploy |
| Domain | £0 | `*.pages.dev`; a custom domain is optional |

**Two card-on-file traps:** do not enable Cloudflare Zero Trust (§1), and
decline the billing account Google Cloud offers during project setup — the Drive
API does not need one.

---

## 7. Known gotchas

1. **Cloudflare Pages preview URLs change per deploy.** They will not match the
   OAuth authorized JavaScript origins, so Drive auth breaks on previews. Use
   the stable production alias. This is expected, not a bug.
2. **GIS uses a popup, not a redirect**, so Google auth does not fight the
   `_worker.js` cookie gate. A redirect flow would have.
3. **`drive.file` is create-scoped.** Deleting or recreating `recipes.json` by
   hand in Drive makes the app lose access to it, requiring re-authorization.
4. **Browser access tokens last ~1 hour** with no refresh token. Silent renewal
   works while a Google session is live in that browser; occasionally a sign-in
   tap is needed.
5. **The password gate protects network fetches only.** Once cached, an unlocked
   stolen phone can read the recipes. Accepted — they are recipes.
