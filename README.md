# Workbench

Workbench is a standalone tmux workbench built from tmux-webui, with a Paseo-inspired layout and neutral zinc colors. It connects to the same tmux server as the selected executable, with a separate frontend, binary, ports, and browser storage.

- **Workspaces:** the button at the main workspace’s upper-left folds/unfolds the left sidebar and remembers its state in this browser. Existing tabs, splits and drafts remain open; `/` unfolds the sidebar and focuses session search. On phones, the header keeps the independent sessions drawer. Search sessions by name or directory; unassigned sessions appear in the default **Untagged** group, after named groups. All groups can be collapsed, and their state survives reload. Drag named group headers to reorder them. Create, rename, or dissolve named groups; move sessions by dragging them onto a group. Holding a session or group near the top or bottom edge of Workspaces scrolls the list automatically; drop or cancel stops scrolling. **Create group from results** takes only matching **Untagged** sessions, assigns them to a new group, and clears the search. Search still shows matching sessions from every group. **Move results to…** explicitly moves all search matches to an existing group or back to Untagged. The group menu provides **Move to top**, **Rename group**, and **Dissolve group** actions. **Move to top** places the group first and saves its order on the server; it is disabled for the first group. Search temporarily reveals matching sessions in collapsed groups.
- **Sessions:** single-click a session to reuse the preview tab in the current pane. Double-click or pin to keep it open. Drag to a pane edge, or choose Split, to preserve deliberate splits. Middle-click closes a tab; **Tab actions → Close other tabs** cleans up the current pane. Closing tabs keeps tmux sessions running. Create sessions in absolute directories, rename them, and use Reader or Terminal. The New session page searches recent paths and running session directories by case-insensitive keywords; multiple keywords can match different parts of a path. Selecting a result fills the working directory, which remains manually editable. Browser sleep reconnects preserve unsent Reader drafts. On desktop, hover over a session to show a Paseo-style details card beside it, or right-click the session for a persistent card. The card shows the session path and current **Group**; choose another named group or **Untagged** to save membership on the server. Hover does not open tabs or take input focus. Escape/outside-click dismisses the card, drag/scroll/resize closes it, and regular session polling preserves its position and selection. The card is desktop-only.
- **Files:** browse the directory shown on the session page. Expand folders in the right sidebar; single-click a text file to open Monaco, or an image to view it with Fit and 100% controls. Double-click a file, or choose **Open in tab**, to keep it open. Text files are editable with **Save** or **Ctrl/Cmd+S**; editing pins the tab, closing or reloading asks before discarding changes, and conflicts preserve the buffer. Terminal, text, and image tabs coexist. Images support PNG, JPEG, GIF, WebP, BMP, AVIF, and SVG. The compact Files toolbar has **New file**, **New folder**, and Refresh icons. New entries use an inline name field: Enter creates, Escape or leaving the field cancels. Toolbar actions start in the session folder; relative paths can address existing subfolders. New text files open in a pinned editable tab and new folders expand. Existing entries are never overwritten. Drag external files into the right sidebar to upload. Empty space uploads to the session root, a folder row targets that folder, and a file row targets its parent. Multiple files upload sequentially with progress; same-name files are preserved, and failed filenames/reasons remain visible. Dropping over Git reveals Files and still uses the session directory. Folder uploads are skipped. Switching sessions or refreshing cancels the old queue. Each file is limited to 50 MiB.
- **Git:** switch the right sidebar to Git to choose a repository for the session. No repository is automatically associated, even when the session directory is itself a Git repository. Search repositories in the current session directory and its subfolders by case-insensitive keywords, or enter an absolute path within that directory. The current directory appears first, followed by nearer subfolders; repositories from other sessions or global history are excluded. The association follows the tmux session ID and is saved on the server. Files continues to browse the session directory. The compact repository summary shows its name, full-path tooltip, branch, short commit and Unbind together; PR state, review and checks use separate small labels. Changes occupies its own scrollable file-tree column, with collapsible directories and a keyword filter. Each changed path appears once; files with both working-tree and staged changes expose a separate **Staged** action. Selecting a file opens a read-only Monaco diff in the main workspace: single-click reuses a preview tab, double-click or pin retains it, and existing split, drag, close, and reload behavior applies. Wide views support side-by-side comparison; narrow panes and phones use inline diff. The sidebar retains current-branch GitHub PR and CI/review state. Binding populates the tree; a diff opens when a file is selected. **Unbind** removes the association and returns to candidate selection. Search and recommendations are hidden while associated; reopening or refreshing the panel does not scan for candidates.
- **Appearance:** dark by default, with light and system themes. Sidebars and editor splits are resizable. On phones, Files opens as a full-screen overlay from the right; choosing a file closes it. Close, Escape, or a right swipe dismisses it; a left swipe from the right edge opens it. Expanded folders stay in place.

Drag sessions above or below other sessions to change their order within a group or place them precisely in another group. Sidebar dragging shows an insertion marker; a split preview appears only after entering the middle workspace. Session order is stored on the server and shared across browsers. The desktop hover card is 260px wide with a compact inline Group selector and a single-line path whose tooltip shows its full value. Search, creation, rename, and Git/PR filtering share neutral input surfaces and focus rings.

While dragging external files, hover over a folder for 600ms to expand it, then navigate deeper before dropping. The tree scrolls near its edges and the compact destination hint leaves rows accessible. Right-click a file or folder to see its absolute path and choose **Copy full path**; Shift+F10 opens the same menu from the keyboard.

The main session view uses a compact two-line identity block: name/rename above, single-line path and connection status below, with view switching and quiet actions on the right. Reader uses small margins and compact rows; its tmux grid follows the current font metrics and usable pane dimensions, including space taken by multiline drafts. Reader input, terminal keys and Send share one composer card. Enter sends, Shift+Enter inserts a newline, and drafts grow to 150px on desktop or 108px on phones before scrolling. Narrow panes stack the toolbar controls; phones retain 16px input text and touch-sized actions.

The right sidebar has a separate **PR** tab for the manually associated repository's current-branch pull request. It shows PR metadata and a searchable, collapsible changed-file tree. Click a file to open a read-only **PR #number** diff tab in the middle workspace; double-click or pin to retain it. PR comparisons use the pull request's merge-base and immutable head commit, including fork repositories, with explicit states for binary files, missing authentication, and unavailable repositories. A changed PR revision or Unbind clears stale diff content. The PR tree loads when its panel is visible. It uses the same mobile overlay as Files and Git.

Group names, order, session membership, and collapsed state are stored on the server and shared across browsers. Newly created groups, including groups created from search results, appear first; existing groups keep their relative order until manually reordered. Existing browser-local groups migrate once when the server has no groups. Changes use revision checks to preserve concurrent edits; other browsers refresh every five seconds. Group membership follows the tmux session ID across renames. Workspace tabs and layout remain in this browser's local storage under `workbench.*`. Search is kept in the URL's `q` parameter. Dissolving a group returns its sessions to Untagged; it does not terminate them. File and diff tabs restore their metadata and fetch current content after reload; unsaved buffers are not stored in local storage. Images are read-only.

## Run locally

Requirements: Go 1.24 or newer, Node.js 22.12 or newer, npm, tmux, and Git. GitHub PR status uses an existing authenticated `gh` installation. Workbench defaults to `127.0.0.1:7690`, leaving tmux-webui's `7681` available.

```bash
make build
./bin/workbench
```

For frontend development, run the Go server and Vite in separate terminals:

```bash
go run ./cmd/workbench
npm --prefix frontend run dev
```

Vite uses port `5174`, forwarding `/api` and `/ws` to `http://127.0.0.1:7690`. Set `WORKBENCH_BACKEND` to change that target. The backend accepts `--listen`, `--tmux`, `--git-runner`, `--allow-remote`, `--filesystem-root`, and `--state-dir` flags. Server group state is written atomically to `groups.json` and repository associations to `git-associations.json` in `--state-dir`, which defaults to the user configuration directory under `workbench`.

```bash
./bin/workbench --listen=127.0.0.1:17690 --tmux=/absolute/path/to/tmux-wrapper
```

The wrapper may select a tmux socket, for example `exec /usr/bin/tmux -L my-server "$@"`. Reader/Terminal and file browsing refer to the same session inventory.

## Docker

```bash
docker compose build workbench
docker compose up -d
```

The provided Compose service uses the existing `host-tmux` helper and host namespaces to reach host tmux sessions. A writable `/:/host` bind mount and `--filesystem-root=/host` expose host session directories to the file browser and editor. Saves apply to existing regular text files inside the selected session directory. `HOST_UID`, `HOST_GID`, and `HOST_TMUX_BIN` select the host tmux user and executable. `WORKBENCH_PORT` changes the published loopback port. Group state is retained in the `workbench-state` volume mounted at `/var/lib/workbench`.

The default listener and Compose publication are loopback-only. `--allow-remote` explicitly permits a non-loopback listener; Workbench has no separate application login. Configure authentication and TLS in a reverse proxy or tunnel before allowing remote access.

## Groups API

`GET /api/groups` returns `{groups, assignments, ungroupedCollapsed, sessionOrder?, revision}`. `sessionOrder` is an optional array of stable tmux IDs used to order sessions within their groups. `PUT /api/groups` submits the same shape with the last revision and a same-origin `Origin` header; omitting `sessionOrder` preserves the current order, while an empty array clears it. A stale revision returns HTTP 409 and the current state; clients rebase their pending operation and retry. Dissolving a group removes its assignments without terminating sessions.

## File API

```text
GET /api/files?session=<tmux ID or name>&path=.
GET /api/file?session=<tmux ID or name>&path=README.md
GET /api/file/image?session=<tmux ID or name>&path=assets/example.png
PUT /api/file  {session, path, content, revision, root}
POST /api/file/upload?session=<tmux ID>&root=<expected session directory>&directory=<relative folder>&name=<filename>
    Body: raw file bytes; returns 201 {root, path, name, size}
```

Each request resolves the session from the current tmux inventory. `root` is the session's displayed absolute directory; `path` and entry paths are relative to it. File reads use Go's rooted filesystem access to prevent directory traversal and symlink escapes. Special files are not previewable. Text reads include a SHA-256 revision; saves compare it and the original root, reject conflicts with HTTP 409, and atomically replace the existing file while preserving its owner and permission bits. Editing through symlinks is rejected. Text previews are limited to 2 MiB, image files to 10 MiB, and directory listings to 1,000 entries. The image endpoint verifies its media type and validates SVG XML before serving. Other binary and invalid UTF-8 files return a readable error. Uploads accept binary or text bytes up to 50 MiB per file. They require same-origin requests and an expected session root, validate the current root and destination directory identity before publication, reject symlink directories, and atomically create a new 0644 file without overwriting any existing path. Conflict returns HTTP 409; incomplete/cancelled uploads remove temporary files. Monaco and its workers are bundled locally; no editor CDN is needed. APIs and WebSocket requests are excluded from service worker caching.

## Git API

```text
GET /api/git?session=<stable tmux ID>
GET /api/git/recommendations?session=<stable tmux ID>&q=<path keywords>
PUT /api/git/association  {session, path: absolutePathOrNull, revision}
GET /api/git/diff?session=<stable tmux ID>&repository=<expected root>&path=<relative path>&kind=staged|unstaged|untracked
GET /api/git/pr/changes?session=<stable tmux ID>
GET /api/git/pr/diff?session=<stable tmux ID>&repository=<expected root>&path=<relative path>&oldPath=<rename source, optional>&number=<PR number>&baseSha=<merge-base>&headSha=<head commit>
```

Status returns repository metadata, the current association and its revision, changes, and a separate PR result. Recommendations return `{root, repositories, truncated}` and recursively discover Git repositories and worktrees only at or below the current session directory. All query words must match before applying the 50-result limit. Search avoids symlink directories and generated dependency/cache trees, reports partial scans, and does not change an existing manual association outside that scope. Association writes require the same origin and current association revision; stale writes return HTTP 409. Changes to different sessions preserve each other's mappings. Clearing an association leaves the session unbound; status and diff require an explicit association. Diff requests reject stale repository roots and traversal, limit content size, and report binary files explicitly.

Local execution uses `git` and optionally `gh` from PATH. The Docker service supplies `--git-runner=/usr/local/bin/host-git`; this helper enters the host mount and network namespaces, selects `HOST_UID`/`HOST_GID`, and resolves that user's home directory so worktree metadata, host DNS, and existing GitHub CLI authentication work correctly. A custom runner accepts `tool directory arguments...`. PR lookup uses the existing host `gh` login; missing authentication, inaccessible remotes, and no PR are displayed as distinct states. Status checks do not fetch or change the repository. Git diff review is a local content preview; no model service is required.

## Verify

```bash
make test
npm --prefix frontend run build
```

The project retains tmux-webui's session, PTY, WebSocket, reconnect, ANSI, workspace, and theme tests, with additional group and file-access coverage. [Browser acceptance](docs/acceptance.md) describes isolated, reproducible checks. `docs/reader-mode-design.md` describes the inherited Reader architecture.
