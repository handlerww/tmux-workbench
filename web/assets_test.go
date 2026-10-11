package web

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Vite can emit lazy Monaco chunks beginning with underscores. Go's default
// directory embedding excludes those names even though browsers request them.
func TestFrontendHiddenChunksAreEmbedded(t *testing.T) {
	err := filepath.WalkDir("dist", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "_") && !strings.HasPrefix(name, ".") {
			return nil
		}
		actual, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		embedded, err := Files.ReadFile(filepath.ToSlash(path))
		if err != nil {
			t.Errorf("built frontend chunk %s is missing from embedded assets: %v", path, err)
			return nil
		}
		if string(actual) != string(embedded) {
			t.Errorf("embedded chunk %s differs from the built frontend", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
