# Browser acceptance

Run commands from the repository root. These checks use disposable files and
sessions under `/tmp/workbench-e2e`, a dedicated `workbench-e2e` tmux socket,
and a separate Workbench server at `127.0.0.1:17690`. Keep the normal tmux
server and any existing Workbench instance separate from the fixtures.

## Build and automated checks

```bash
make build
go test ./...
go vet ./...
npm --prefix frontend test
```

## Start the isolated server

Requires tmux and an installed Playwright CLI with a Chromium browser.

```bash
mkdir -p artifacts
scripts/browser-fixture.sh start
./bin/workbench --listen=127.0.0.1:17690 \
  --tmux=/tmp/workbench-e2e/tmux \
  --state-dir=/tmp/workbench-e2e/state
```

Leave the server running in that terminal. From another terminal, open a
browser and run the general workspace and editor checks:

```bash
playwright-cli -s=workbench open http://127.0.0.1:17690/
playwright-cli -s=workbench run-code --filename=scripts/browser-acceptance.js
playwright-cli -s=workbench run-code --filename=scripts/editor-acceptance.js
```

The scripts write screenshots to the ignored `artifacts/` directory. Further
checks cover groups, search, session ordering, Files, uploads, Git and PR
diffs. Read each script's setup requirements before running it. Creation
checks use `scripts/files-create-fixture.sh`; upload checks use
`scripts/upload-fixture.sh`.

## Git and PR fixtures

`scripts/git-fixture.sh start` creates disposable Git repositories and a
runner that provides deterministic GitHub responses. `scripts/git-tree-fixture.sh`
adds changed paths for file-tree checks. Restart the isolated server with
`--git-runner=/tmp/workbench-git-e2e/runner` to use these fixtures.

For PR diff checks, run `python3 scripts/pr-fixture.py` after the Git fixtures
are ready, then restart the server with
`--git-runner=/tmp/workbench-pr-e2e/runner`. Run
`scripts/pr-panel-acceptance.js` through Playwright CLI. The runner uses
synthetic GitHub metadata and commit contents without contacting GitHub.

## Stop fixtures

Close the named browser with `playwright-cli -s=workbench close`, stop the
isolated Workbench process in its terminal, then run:

```bash
scripts/git-fixture.sh stop
scripts/browser-fixture.sh stop
```

Only run the Git stop command if its fixture was started. The browser fixture
stop command targets the dedicated socket and the two named fixture sessions.
Temporary fixture files remain under `/tmp` for inspection.
