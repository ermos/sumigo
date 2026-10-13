// Package web serves the built React app (web/dist) with SPA fallback.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

func Handler() http.Handler {
	sub, _ := fs.Sub(dist, "dist")
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := fs.Stat(sub, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
			r.URL.Path = "/"
		}
		files.ServeHTTP(w, r)
	})
}
