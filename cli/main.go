// Command devhub drives the running DevHub from a terminal. It is a client
// of DevHub's control socket and nothing else: every decision is made by the
// app on the other side, `--tell`'s words included (docs/devhub-cli.md).
//
// One static binary, built from source by the app build (cgo off), for this
// Mac and for the Linux hosts DevHub reaches over SSH, so no machine needs a
// Node to run it.
package main

import "os"

func main() {
	os.Exit(devhubMain(os.Args[1:], osEnvironment()))
}
