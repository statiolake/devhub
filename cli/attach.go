package main

import (
	"encoding/base64"
	"fmt"
	"os"
)

// What one `--tell` may carry: a file, and all of them. The app checks the
// same (`main/orchestrator/attachments.ts`); these keep a request it would
// refuse from being read and sent at all.
const (
	MaxAttachment      = 10 << 20
	MaxAttachmentTotal = 25 << 20
)

// ReadAttachments reads the files an answer asked for (`--attach`), on this
// machine: each a regular file, within the limits, base64 by its path. The
// app names them by the absolute path it made of the words where they were
// typed, so they are read as named.
func ReadAttachments(paths []string) (map[string]string, error) {
	files := make(map[string]string, len(paths))
	total := int64(0)
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("%s is not there", path)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("%s is not a file", path)
		}
		if info.Size() > MaxAttachment {
			return nil, fmt.Errorf("%s is %.1f MB; a file is at most %d MB", path, float64(info.Size())/(1<<20), MaxAttachment>>20)
		}
		total += info.Size()
		if total > MaxAttachmentTotal {
			return nil, fmt.Errorf("the files come to more than %d MB, the most one command carries", MaxAttachmentTotal>>20)
		}
		bytes, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("%s could not be read: %v", path, err)
		}
		files[path] = base64.StdEncoding.EncodeToString(bytes)
	}
	return files, nil
}
