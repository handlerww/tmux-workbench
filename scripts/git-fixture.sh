#!/bin/sh
set -eu

# Deterministic Git fixtures for Git browser acceptance. The main and nested
# repositories live below alpha's non-Git cwd. Beta remains a separate
# non-Git session so recommendations cannot depend on another session's root.
ROOT=/tmp/workbench-git-e2e
SESSION_ROOT=/tmp/workbench-e2e/project
REPOS=$SESSION_ROOT/repos
REPO=$REPOS/other
DEEP_REPO=$REPO/deep/leaf
OUTSIDE_REPO=$ROOT/outside
DEPENDENCY_REPO=$REPO/node_modules/ignored-fixture
RUNNER=$ROOT/runner
GIT_BIN=$(command -v git || true)

usage() {
	cat <<'EOF'
Usage: scripts/git-fixture.sh start|stop

start initializes isolated repositories below the alpha session root and
installs a host runner that delegates Git and returns a deterministic fake
GitHub PR response. It does not modify tmux sessions or the default socket.
stop removes only the generated runner directory and the owned
/tmp/workbench-e2e/project/repos fixture subtree.
EOF
}

if [ "$#" -ne 1 ]; then
	usage >&2
	exit 2
fi

if [ -z "$GIT_BIN" ]; then
	echo "Git fixture: git executable not found" >&2
	exit 1
fi

case "$1" in
start)
	if [ ! -d "$SESSION_ROOT" ] || [ -L "$SESSION_ROOT" ]; then
		echo "Git fixture: expected real browser-fixture session directory $SESSION_ROOT" >&2
		echo "Run scripts/browser-fixture.sh start first." >&2
		exit 1
	fi
	if [ -L "$ROOT" ]; then
		echo "Git fixture: refusing to use symlink at $ROOT" >&2
		exit 1
	fi
	if [ -L "$REPOS" ]; then
		echo "Git fixture: refusing to replace symlink at $REPOS" >&2
		exit 1
	fi
	mkdir -p "$ROOT"
	case "$REPOS" in /tmp/workbench-e2e/project/repos) ;; *) echo "Git fixture: unsafe repo path" >&2; exit 1 ;; esac
	rm -rf "$REPOS" "$OUTSIDE_REPO"
	mkdir -p "$REPO" "$DEEP_REPO" "$OUTSIDE_REPO" "$DEPENDENCY_REPO"
	cat > "$REPO/README.md" <<'EOF'
# Workbench scoped Git fixture

This repository is nested below the alpha session root.
EOF
	cat > "$REPO/.gitignore" <<'EOF'
/deep/
/node_modules/
/unsafe-external-link
EOF
	rm -f "$REPO"/git-staged.txt "$REPO"/git-unstaged.txt "$REPO"/git-untracked.txt \
		"$REPO"/git-deleted-staged.txt "$REPO"/git-deleted-unstaged.txt \
		"$REPO"/git-rename-old.txt "$REPO"/git-rename-new.txt "$REPO"/git-both.txt

	cat > "$REPO/git-staged.txt" <<'EOF'
staged baseline
EOF
	cat > "$REPO/git-unstaged.txt" <<'EOF'
unstaged baseline
EOF
	cat > "$REPO/git-deleted-staged.txt" <<'EOF'
staged deletion baseline
EOF
	cat > "$REPO/git-deleted-unstaged.txt" <<'EOF'
unstaged deletion baseline
EOF
	cat > "$REPO/git-rename-old.txt" <<'EOF'
rename baseline content line
keep identical context line two
keep identical context line three
EOF
	cat > "$REPO/git-both.txt" <<'EOF'
both baseline
EOF

	"$GIT_BIN" -C "$REPO" init -q -b main
	"$GIT_BIN" -C "$REPO" config user.name "Workbench Git Fixture"
	"$GIT_BIN" -C "$REPO" config user.email "workbench-fixture@example.invalid"
	"$GIT_BIN" -C "$REPO" add README.md .gitignore git-staged.txt git-unstaged.txt git-deleted-staged.txt git-deleted-unstaged.txt git-rename-old.txt git-both.txt
	"$GIT_BIN" -C "$REPO" commit -qm "Create deterministic Workbench Git fixture"
	"$GIT_BIN" -C "$REPO" switch -qc workbench-fixture

	cat > "$DEEP_REPO/README.md" <<'EOF'
# Workbench deep scoped Git fixture
EOF
	"$GIT_BIN" -C "$DEEP_REPO" init -q -b main
	"$GIT_BIN" -C "$DEEP_REPO" config user.name "Workbench Git Fixture"
	"$GIT_BIN" -C "$DEEP_REPO" config user.email "workbench-fixture@example.invalid"
	"$GIT_BIN" -C "$DEEP_REPO" add README.md
	"$GIT_BIN" -C "$DEEP_REPO" commit -qm "Create nested repository fixture"
	cat > "$DEEP_REPO/deep-change.txt" <<'EOF'
deep scoped change
EOF

	cat > "$OUTSIDE_REPO/README.md" <<'EOF'
# Workbench outside-scope Git fixture
EOF
	"$GIT_BIN" -C "$OUTSIDE_REPO" init -q -b main
	"$GIT_BIN" -C "$OUTSIDE_REPO" config user.name "Workbench Git Fixture"
	"$GIT_BIN" -C "$OUTSIDE_REPO" config user.email "workbench-fixture@example.invalid"
	"$GIT_BIN" -C "$OUTSIDE_REPO" add README.md
	"$GIT_BIN" -C "$OUTSIDE_REPO" commit -qm "Create outside-scope repository fixture"

	cat > "$DEPENDENCY_REPO/README.md" <<'EOF'
# Workbench dependency repository fixture
EOF
	"$GIT_BIN" -C "$DEPENDENCY_REPO" init -q -b main
	"$GIT_BIN" -C "$DEPENDENCY_REPO" config user.name "Workbench Git Fixture"
	"$GIT_BIN" -C "$DEPENDENCY_REPO" config user.email "workbench-fixture@example.invalid"
	"$GIT_BIN" -C "$DEPENDENCY_REPO" add README.md
	"$GIT_BIN" -C "$DEPENDENCY_REPO" commit -qm "Create dependency-skip repository fixture"
	ln -s "$OUTSIDE_REPO" "$REPO/unsafe-external-link"

	cat > "$REPO/git-untracked.txt" <<'EOF'
untracked content visible in Monaco diff
EOF
	cat > "$REPO/git-staged.txt" <<'EOF'
staged change visible in the index
EOF
	"$GIT_BIN" -C "$REPO" add git-staged.txt
	cat > "$REPO/git-unstaged.txt" <<'EOF'
unstaged change visible in the working tree
EOF
	"$GIT_BIN" -C "$REPO" rm -q git-deleted-staged.txt
	rm "$REPO/git-deleted-unstaged.txt"
	"$GIT_BIN" -C "$REPO" mv git-rename-old.txt git-rename-new.txt
	cat > "$REPO/git-rename-new.txt" <<'EOF'
rename staged content line
keep identical context line two
keep identical context line three
EOF
	"$GIT_BIN" -C "$REPO" add git-rename-new.txt
	cat > "$REPO/git-rename-new.txt" <<'EOF'
rename final content line
keep identical context line two
keep identical context line three
EOF
	cat > "$REPO/git-both.txt" <<'EOF'
staged version
EOF
	"$GIT_BIN" -C "$REPO" add git-both.txt
	cat > "$REPO/git-both.txt" <<'EOF'
unstaged version after staging
EOF

	HEAD=$($GIT_BIN -C "$REPO" rev-parse HEAD)
	cat > "$RUNNER" <<EOF
#!/bin/sh
set -eu
tool=\$1
repository=\$2
shift 2
case "\$repository" in
	"$REPO"|"$DEEP_REPO"|"$OUTSIDE_REPO"|"$DEPENDENCY_REPO") ;;
	*) echo "fixture runner accepts only the owned repositories" >&2; exit 64 ;;
esac
if [ "\$tool" != git ] && [ "\$tool" != gh ]; then
	echo "unsupported fixture tool: \$tool" >&2
	exit 64
fi
case "\$tool" in
git)
	exec "$GIT_BIN" -C "\$repository" "\$@"
	;;
gh)
	if [ "\${1:-}" = auth ] && [ "\${2:-}" = status ]; then
		echo 'Logged in to github.com as workbench-fixture'
		exit 0
	fi
	if [ "\${1:-}" = pr ] && [ "\${2:-}" = view ]; then
		cat <<'JSON'
{"number":4242,"title":"Workbench Git browser fixture","url":"https://github.com/example/workbench/pull/4242","state":"OPEN","isDraft":false,"baseRefName":"main","headRefName":"workbench-fixture","headRefOid":"$HEAD","headRepositoryOwner":{"login":"example"},"reviewDecision":"APPROVED","statusCheckRollup":[{"name":"fixture-check","conclusion":"SUCCESS"}],"updatedAt":"2026-10-08T00:00:00Z"}
JSON
		exit 0
	fi
	if [ "\${1:-}" = pr ]; then
		echo 'no pull requests found for this branch' >&2
		exit 1
	fi
	;;
*)
	echo "unsupported fixture tool: \$tool" >&2
	exit 64
	;;
esac
echo 'unsupported fixture command' >&2
exit 64
EOF
	chmod 700 "$RUNNER"
	printf 'Git browser fixture ready\n'
	printf 'Repository: %s\n' "$REPO"
	printf 'Nested repository: %s\n' "$DEEP_REPO"
	printf 'Runner: %s\n' "$RUNNER"
	printf 'Configure Workbench with --git-runner=%s\n' "$RUNNER"
	;;
stop)
	if [ -L "$ROOT" ]; then
		echo "Git fixture: refusing to remove symlink at $ROOT" >&2
		exit 1
	fi
	if [ -L "$REPOS" ]; then
		echo "Git fixture: refusing to remove symlink at $REPOS" >&2
		exit 1
	fi
	rm -rf "$ROOT"
	rm -rf "$REPOS"
	printf 'Removed the isolated Git runner and scoped repository fixture subtree.\n'
	;;
*)
	usage >&2
	exit 2
	;;
esac
