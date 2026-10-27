# `migrations/` — schema of the SQLite database

Each file `NNNN_description.sql` changes the schema of the app database. The files are applied in order, by version:

- in the desktop app, by the Tauri SQL plugin when the app starts: every file is listed, with its version, in `migrations()` of `src-tauri/src/lib.rs` (a Rust test checks that every `.sql` file of this folder is listed there, in order, with the version of its name and its exact text, and that the versions follow each other from 1);
- in the tests and the browser dev mode, by the sql.js adapter (`src/adapters/dev/sql-js-database.adapter.ts`), which applies every `.sql` file of this folder to a new in-memory database.

Both run the same SQLite engine, so plain SQLite works everywhere.

## Rules

- **Never edit a released migration.** The SQL plugin stores a checksum of every applied migration and refuses to open a database whose applied migration changed, even by a whitespace: the app would no longer start. Every change goes in a new file with the next number, added to `migrations()` in `lib.rs`.
- Line endings are LF on every computer (`.gitattributes`): the checksum depends on them.
- Times of matches (`start_time`) are Unix seconds, as deadlock-api returns them; every other time is in Unix milliseconds. Booleans are `0`/`1`. Tables are `STRICT`: SQLite refuses a value of the wrong type instead of storing it.
- SQLite cannot change a `CHECK` constraint in place, so a migration that adds a value to one (such as a new `detail_status`, as `0006_evicted_status.sql` does for `evicted`) rebuilds the table: it creates the new table with every column and its definition, copies the rows with each column named on both sides, drops the old table, renames the new one and creates the indexes again. The plugin runs a migration in one transaction, so a failure leaves the old table as it was. Check that no foreign key, view or trigger refers to the table first, as dropping it would break them.
- While developing a migration that is not released yet, the development database is the only one that applied it: if `pnpm dev:desktop` no longer starts after you edited it, delete the development data folder (`%APPDATA%\io.github.gonzalezedev.thelibrary.dev` on Windows).
