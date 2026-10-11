package web

import "embed"

//go:generate npm --prefix ../frontend run build

// Files contains the production frontend bundle.
//
//go:embed all:dist
var Files embed.FS
