// Command devhub drives the running DevHub from a terminal. It is a client
// of DevHub's control socket and nothing else: every decision is made by the
// app on the other side, `--tell`'s words included (docs/devhub-cli.md).
//
// One static binary, built from source by the app build (cgo off), for this
// Mac and for the Linux hosts DevHub reaches over SSH, so no machine needs a
// Node to run it. Copied into a DevHub pane's PATH as `nvim`, it is DevHub's
// `nvim` instead (nvim.go).
package main

import (
	"os"
	"path/filepath"
)

func main() {
	if isNvimName(os.Args[0]) {
		os.Exit(nvimMain(executableDirectory(), os.Args[1:]))
	}
	os.Exit(devhubMain(os.Args[1:], osEnvironment()))
}

// executableDirectory is where this binary is, for the facts beside it.
func executableDirectory() string {
	path, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(path)
}
