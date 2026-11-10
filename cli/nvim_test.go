package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The test binary is DevHub's `nvim` when asked to be: its facts in the
// directory DEVHUB_TEST_NVIM_FACTS names.
func TestMain(m *testing.M) {
	if directory := os.Getenv("DEVHUB_TEST_NVIM_FACTS"); directory != "" {
		os.Exit(nvimMain(directory, os.Args[1:]))
	}
	os.Exit(m.Run())
}

// nvimFixture: facts naming a fake Neovim that prints its arguments and
// VIMRUNTIME, and a tmux that fails.
func nvimFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	fake := filepath.Join(directory, "real-nvim")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\necho \"devhub $* runtime=${VIMRUNTIME-unset}\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	facts, _ := json.Marshal(NvimFacts{Nvim: fake, Tmux: "/bin/false", SessionPrefixes: []string{"tm-", "ws-"}})
	if err := os.WriteFile(filepath.Join(directory, NvimFactsFile), facts, 0o644); err != nil {
		t.Fatal(err)
	}
	return directory
}

func runNvim(t *testing.T, directory string, env []string, args ...string) string {
	t.Helper()
	command := exec.Command(os.Args[0], args...)
	command.Env = append([]string{"DEVHUB_TEST_NVIM_FACTS=" + directory, "PATH=/usr/bin:/bin"}, env...)
	out, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return string(out)
}

func TestNvimIsTheTUIOutsideADevHubPane(t *testing.T) {
	directory := nvimFixture(t)
	// The runtime is found beside it, not the one another Neovim set.
	got := runNvim(t, directory, []string{"VIMRUNTIME=/opt/homebrew/share/nvim/runtime"}, "a b", "c")
	if got != "devhub a b c runtime=unset\n" {
		t.Fatalf("got %q", got)
	}
}

func TestNvimSaysWhyWithDebug(t *testing.T) {
	directory := nvimFixture(t)
	for _, c := range []struct {
		env  []string
		args []string
		why  string
	}{
		{nil, nil, "not in a tmux pane"},
		{[]string{"TMUX=/s,1,0", "TMUX_PANE=%1", "DEVHUB_NEOVIM_GUI=1"}, nil, "inside a Neovim DevHub draws"},
		// Not a terminal: the test's stdin and stdout are pipes.
		{[]string{"TMUX=/s,1,0", "TMUX_PANE=%1"}, nil, "stdin or stdout is not a terminal"},
	} {
		got := runNvim(t, directory, append([]string{"DEVHUB_NVIM_DEBUG=1"}, c.env...), c.args...)
		if !strings.Contains(got, c.why) || !strings.Contains(got, "devhub  runtime=unset") {
			t.Fatalf("%v: got %q", c.env, got)
		}
	}
}

func TestNvimEditingArguments(t *testing.T) {
	s := &nvimShim{}
	for _, args := range [][]string{{"--headless"}, {"-es"}, {"--remote-send", "x"}, {"a", "-"}, {"--version"}} {
		s.args = args
		if s.editing() {
			t.Fatalf("%v is not an editing session", args)
		}
	}
	for _, args := range [][]string{nil, {"a.txt"}, {"-o", "a", "b"}, {"--", "--version"}} {
		s.args = args
		if !s.editing() {
			t.Fatalf("%v is an editing session", args)
		}
	}
}

func TestNvimWithoutFacts(t *testing.T) {
	command := exec.Command(os.Args[0])
	command.Env = []string{"DEVHUB_TEST_NVIM_FACTS=" + t.TempDir()}
	out, _ := command.CombinedOutput()
	if command.ProcessState.ExitCode() != 127 || !strings.Contains(string(out), NvimFactsFile) {
		t.Fatalf("got %d %q", command.ProcessState.ExitCode(), out)
	}
}

func TestFormatEscape(t *testing.T) {
	if got := formatEscape("a#b,c}d"); got != "a##b#,c#}d" {
		t.Fatalf("got %q", got)
	}
}

// After `:restart` the pane waits on each new server by the pid its setup
// writes, and ends with the last one's status.
func TestFollowRestarts(t *testing.T) {
	dir := t.TempDir()
	if got := followRestarts(dir, 1, 3); got != 3 {
		t.Fatalf("no restart: got %d", got)
	}
	server := exec.Command("sleep", "0.3")
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	go server.Wait()
	os.WriteFile(filepath.Join(dir, "restart"), []byte("restart\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.Itoa(server.Process.Pid)+"\n"), 0o644)
	go func() {
		time.Sleep(100 * time.Millisecond)
		os.WriteFile(filepath.Join(dir, "exit"), []byte("4\n"), 0o644)
	}()
	if got := followRestarts(dir, 1, 0); got != 4 {
		t.Fatalf("after a restart: got %d", got)
	}
}
