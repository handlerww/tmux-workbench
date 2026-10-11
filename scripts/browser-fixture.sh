#!/bin/sh
set -eu

# This fixture uses a dedicated tmux socket. Every tmux command below names
# that socket explicitly so the user's default tmux server is never touched.
SOCKET=workbench-e2e
BASE=/tmp/workbench-e2e
PROJECT=$BASE/project
OTHER=$BASE/other
TMUX_BIN=$(command -v tmux || true)

usage() {
	cat <<'EOF'
Usage: scripts/browser-fixture.sh start|stop

Creates or stops the isolated browser-acceptance tmux sessions on socket
workbench-e2e. It does not use the default tmux socket.
EOF
}

if [ "$#" -ne 1 ]; then
	usage >&2
	exit 2
fi

if [ -z "$TMUX_BIN" ]; then
	echo "browser fixture: tmux executable not found" >&2
	exit 1
fi

case "$1" in
start)
	mkdir -p "$PROJECT/src" "$OTHER"
	cat > "$PROJECT/README.md" <<'EOF'
# Workbench browser fixture

This file is used by the Workbench browser acceptance fixture.
EOF
	cat > "$PROJECT/config.json" <<'EOF'
{
  "name": "workbench-browser-fixture",
  "purpose": "reproducible acceptance testing"
}
EOF
	cat > "$PROJECT/src/main.js" <<'EOF'
function greet(name) {
  return `Hello, ${name}!`;
}

console.log(greet('Workbench'));
EOF
	printf 'fixture binary\000payload\377\n' > "$PROJECT/binary.bin"
	printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1QAAAAASUVORK5CYII=' | base64 -d > "$PROJECT/pixel.png"
	cat > "$PROJECT/sample.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#71717a"/></svg>
EOF
	dd if=/dev/zero of="$PROJECT/large.txt" bs=1048576 count=3 2>/dev/null
	cat > "$OTHER/README.md" <<'EOF'
# Workbench other session

This directory belongs to the second browser fixture session.
EOF
	if [ -e "$PROJECT/escape" ] || [ -L "$PROJECT/escape" ]; then
		rm -f "$PROJECT/escape"
	fi
	ln -s /etc "$PROJECT/escape"
	cat > "$BASE/tmux" <<EOF
#!/bin/sh
exec "$TMUX_BIN" -L "$SOCKET" "\$@"
EOF
	chmod 755 "$BASE/tmux"
	if ! "$TMUX_BIN" -L "$SOCKET" has-session -t '=workbench-alpha' 2>/dev/null; then
		"$TMUX_BIN" -L "$SOCKET" new-session -d -s workbench-alpha -c "$PROJECT"
	fi
	if ! "$TMUX_BIN" -L "$SOCKET" has-session -t '=workbench-beta' 2>/dev/null; then
		"$TMUX_BIN" -L "$SOCKET" new-session -d -s workbench-beta -c "$OTHER"
	fi
	printf 'Browser fixture ready on tmux socket %s\n' "$SOCKET"
	printf 'Session roots: %s and %s\n' "$PROJECT" "$OTHER"
	printf 'Use %s/tmux as the Workbench tmux binary.\n' "$BASE"
	;;
stop)
	for name in workbench-alpha workbench-beta; do
		if "$TMUX_BIN" -L "$SOCKET" has-session -t "=$name" 2>/dev/null; then
			"$TMUX_BIN" -L "$SOCKET" kill-session -t "=$name"
		fi
	done
	printf 'Stopped browser fixture sessions on tmux socket %s\n' "$SOCKET"
	;;
*)
	usage >&2
	exit 2
	;;
esac
