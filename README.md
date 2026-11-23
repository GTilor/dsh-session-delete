# dsh-session-delete-lite

DeepSeek Harness ships archive, pin, rename and fork for sidebar sessions — but no delete. This plugin adds that one action, and nothing else.

## What it does

- Adds **Delete session** to every session's `⋯` menu in the sidebar.
- Greys the row out while the session is running or waiting on you.
- Asks for confirmation once, then really deletes.

Deletion removes the session's directory under `~/.dsh/sessions/`, its workspace-list entry, its projection-cache record and its spilled tool results. **It cannot be undone** — archive only tucks a session away; this really deletes.

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

For a loaded session, the plugin uses DSH's teardown before calling the workspace registry and cleaning up files. If the session stays loaded, the dialog asks you to restart DSH and retry.

## Requirements

DeepSeek Harness `^0.2.3-alpha.2`. Desktop and `dsh web` share the same Web-side APIs. The delete route has been tested with the `dsh web` host.

## License

MIT.
