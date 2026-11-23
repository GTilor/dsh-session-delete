# dsh-session-delete-lite

DeepSeek Harness ships archive, pin, rename and fork for sidebar sessions — but no delete. This plugin adds that one action, and nothing else.

## What it does

- Adds **Delete session** to every session's `⋯` menu in the sidebar.
- Greys the row out while the session is running or waiting on you.
- Asks for confirmation once, then really deletes.

Deletion removes the session's directory under `~/.dsh/sessions/`, its workspace-list entry, its projection-cache record and its spilled tool results. **It cannot be undone** — archive only tucks a session away; this really deletes.

If the session you delete is the one on screen, the view moves to a fresh session in the same workspace. If a full removal is not possible, the row is hidden instead and you are told so.

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

`index.js` registers two private routes (`/_dsh-session-delete/status`, `/_dsh-session-delete/delete`) and does the work. `client.js` renders the menu row and the confirm dialog through DSH's own slots (`sidebar.workspaces.session.menu.item`, `shell.overlay`) and touches nothing else.

Deleting a session that is still loaded needs an unload, and DSH has no documented API for it; the plugin uses the framework's own teardown and probes every step. When the probe fails it hides the row and says so instead of claiming a clean delete.

## Requirements

DeepSeek Harness `^0.2.3-alpha.2`. Desktop and `dsh web` share the same Web-side APIs; only the desktop build is tested.

## License

MIT. Adapted from [DeepSeekHarness-Session-Delete](https://github.com/Ansellwan/DeepSeekHarness-Session-Delete) by Ansellwan, with the group-cleanup panel removed.
