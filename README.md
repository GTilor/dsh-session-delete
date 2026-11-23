# dsh-session-delete-lite

DeepSeek Harness ships archive, pin, rename and fork for sidebar sessions — but no delete. This plugin adds that one action, and nothing else.

## What it does

- Adds **Delete session** to every session's `⋯` menu in the sidebar.
- Greys the row out while the session is running or waiting on you.
- Asks for confirmation once, then really deletes.

Deletion removes the JSONL directory DSH identifies for the session, its workspace-list entry, its projection cache and its spilled tool results. Both default and custom directories are supported. The plugin checks with DSH that the record is gone before reporting success. **Deletion is permanent.**

SQLite stores multiple sessions in a shared database. For those sessions, the dialog explains the storage limitation and preserves both the history and the sidebar entry.

When you delete the session on screen, the view moves to a fresh session in the same workspace. If cleanup is incomplete, the dialog tells you and stays open so you can retry.

## Install

```bash
dsh plugin --profile desktop add github:GTilor/dsh-session-delete
```

Or install the folder: **Plugins** → **Add plugin** → pick this directory. Restart DSH afterwards.

## Remove

```bash
dsh plugin --profile desktop remove dsh-session-delete-lite
```

## How it works

`index.js` handles `POST /_dsh-session-delete/delete`. `client.js` renders the menu row and the confirm dialog through DSH's `sidebar.workspaces.session.menu.item` and `shell.overlay` slots.

When you confirm, the plugin checks for activity reported by DSH. If a host Agent still holds the session, the dialog asks you to restart DSH and retry. Otherwise, the plugin uses DSH's session teardown before updating the workspace registry and cleaning up files.

Run `npm test` in the project directory to run the regression tests with temporary sessions.

## Requirements

DeepSeek Harness `^0.2.3-alpha.2`. Desktop and `dsh web` share the same Web-side APIs. The delete route has been tested with the `dsh web` host.

## License

MIT.
