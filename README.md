# recipes-app

A personal cooking-recipe app. Create, edit, delete and categorise recipes with
link references, on a phone, in a kitchen, with bad wifi.

Design and phasing live in [PLAN.md](PLAN.md).

**Status:** Phase 1 complete - local CRUD on IndexedDB. Not yet a PWA, not yet
deployed, not yet synced to Drive.

## Run it

No build step and no dependencies. Any static file server works:

```bash
python -m http.server 8000 --directory public
```

Then open <http://localhost:8000>.

## Test

```bash
node test/db.test.js
```

14 assertions against `public/db.js` with an in-memory IndexedDB fake - covers
record normalisation, soft deletes, and the last-write-wins merge that Phase 4's
Drive sync will reuse.

## Layout

```
public/
  index.html     three screens: list, detail, editor
  app.js         routing, rendering, form handling
  db.js          IndexedDB wrapper - the only thing that touches storage
  style.css
  icons/         (empty until Phase 2)
test/
  db.test.js
PLAN.md
```

## Where the data is

IndexedDB, in the browser you used, under the origin you served from.

**Until Phase 4 (Drive sync) that is the only copy.** Clearing site data
destroys it. Use *Menu -> Export JSON backup* if you enter anything you would
mind losing. Import merges by last-write-wins, so re-importing an old backup
cannot overwrite newer edits or resurrect a deleted recipe.

## Conventions

- **No framework, no build step, no dependencies.** The app is static files.
- **`db.js` is the only module that touches storage.** Everything else calls it.
- **Deletes are soft.** A record gets `deletedAt` and stays. A hard delete cannot
  be synced - the other device would just re-add it.
- **`updatedAt` is stamped on every write.** It is what the sync merge compares.
