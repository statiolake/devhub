package main

// DevHub's `nvim`: the same binary as `devhub`, copied into the directory in
// front of every DevHub pane's PATH under the name `nvim`
// (apps/desktop/src/main/editor/terminalNeovimShim.ts, docs/neovim-editor.md
// "Neovim in a terminal"). Run as `nvim` it runs DevHub's Neovim — its
// absolute path is in the facts file beside it, never looked up on the PATH —
// with the person's arguments, in the pane, as the pane's foreground program:
// its exit status, environment, cwd and life are the pane's, as a TUI's
// would be. Only who draws it changes: `--embed --listen <socket>` instead
// of the TUI, and DevHub attaches to that socket as its only UI.
//
// It is the pane's foreground program itself, under the name `nvim`, so
// tmux names the window `nvim` (`/proc/<pid>/cmdline` on Linux, `p_comm` —
// the executable's own file name — on macOS), and it does on its own what a
// shell script did with a dozen programs: no `mktemp`, `mkfifo`, `cat`,
// `stty` or `sleep`, no `nvim -l` launcher, and one `tmux` client that both
// reads the pane and names the socket. Between Enter and DevHub's attach
// that is the difference between ~40 ms and a few.
//
// When DevHub would not draw it — outside a DevHub pane, inside a Neovim
// DevHub draws, stdin or stdout not a terminal, arguments that are not an
// editing session, the overlay off, a pane that has one already, no UI within
// the wait — it `exec`s the same Neovim as a TUI, untouched.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// NvimFactsFile is the file beside the `nvim` copy that says what the
// binary cannot discover: written by DevHub with the copy (`NeovimShimFacts`).
const NvimFactsFile = "nvim-shim.json"

// The pane and server options DevHub and the pane's `nvim` speak through
// (`terminalNeovimShim.ts`).
const (
	nvimSocketOption  = "@devhub-nvim"
	nvimOverlayOption = "@devhub-nvim-overlay"
	nvimStateVariable = "DEVHUB_NVIM_STATE"
	nvimNamedOSC      = "\x1b]6973;devhub-nvim\x07"
	// How long a restarted server is waited for to say its pid, in tenths
	// (`NVIM_RESTART_WAIT_TENTHS`).
	nvimRestartWaitTenths = 150
)

// NvimFacts is `nvim-shim.json`.
type NvimFacts struct {
	// DevHub's Neovim on this machine, by its absolute path.
	Nvim string `json:"nvim"`
	// The tmux of DevHub's server on this machine, by its absolute path.
	Tmux string `json:"tmux"`
	// What the sessions it draws over are named with (`tm-`, `ws-`).
	SessionPrefixes []string `json:"sessionPrefixes"`
	// How long it waits for DevHub's UI, in tenths of a second.
	UIWaitTenths int `json:"uiWaitTenths"`
	// The tty reader (`TTY_KEYS_LUA`), run under `nvim -l` once attached.
	Keys string `json:"keys"`
}

// isNvimName says whether this binary was run as DevHub's `nvim`.
func isNvimName(argv0 string) bool {
	return filepath.Base(argv0) == "nvim"
}

// nvimMain is DevHub's `nvim`, with the facts in `directory`.
func nvimMain(directory string, args []string) int {
	raw, err := os.ReadFile(filepath.Join(directory, NvimFactsFile))
	var facts NvimFacts
	if err == nil {
		err = json.Unmarshal(raw, &facts)
	}
	if err != nil || facts.Nvim == "" {
		fmt.Fprintf(os.Stderr, "nvim: DevHub's nvim has no %s beside it; reconnect or restart DevHub\n", NvimFactsFile)
		return 127
	}
	if facts.UIWaitTenths <= 0 {
		facts.UIWaitTenths = 100
	}
	if syscall.Access(facts.Nvim, 1) != nil {
		fmt.Fprintf(os.Stderr, "nvim: DevHub's Neovim (%s) is not there; reconnect or restart DevHub\n", facts.Nvim)
		return 127
	}
	s := &nvimShim{facts: facts, args: args, debug: os.Getenv("DEVHUB_NVIM_DEBUG") != ""}
	// It finds its runtime beside itself; one inherited from another Neovim
	// is that Neovim's.
	for _, entry := range os.Environ() {
		if strings.HasPrefix(entry, "VIMRUNTIME=") || strings.HasPrefix(entry, "VIM=") {
			continue
		}
		s.env = append(s.env, entry)
	}
	return s.run()
}

type nvimShim struct {
	facts NvimFacts
	args  []string
	env   []string
	debug bool
	pane  string
	dir   string
}

// why says on stderr, with DEVHUB_NVIM_DEBUG=1, why it runs the TUI.
func (s *nvimShim) why(format string, values ...any) {
	if s.debug {
		fmt.Fprintf(os.Stderr, "DevHub's nvim runs %s as it is: %s\n", s.facts.Nvim, fmt.Sprintf(format, values...))
	}
}

// tui is the same Neovim as a TUI, in place of this process.
func (s *nvimShim) tui() int {
	signal.Reset(syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTSTP)
	err := syscall.Exec(s.facts.Nvim, append([]string{s.facts.Nvim}, s.args...), s.env)
	fmt.Fprintf(os.Stderr, "nvim: %s: %s\n", s.facts.Nvim, err)
	return 127
}

// editing says whether the arguments are an editing session DevHub can draw.
func (s *nvimShim) editing() bool {
	for _, argument := range s.args {
		switch {
		case argument == "--":
			return true
		case argument == "-", argument == "--headless", argument == "--embed", argument == "--listen",
			argument == "-es", argument == "-Es", argument == "-e", argument == "-E",
			argument == "-l", argument == "-L", argument == "-r", argument == "-h", argument == "-v",
			argument == "-?", argument == "--help", argument == "--version", argument == "--api-info",
			argument == "--server", strings.HasPrefix(argument, "--remote"):
			s.why("not an editing session (%s)", argument)
			return false
		}
	}
	return true
}

func (s *nvimShim) run() int {
	s.pane = os.Getenv("TMUX_PANE")
	switch {
	case s.pane == "" || os.Getenv("TMUX") == "":
		s.why("not in a tmux pane (TMUX_PANE, TMUX)")
		return s.tui()
	case os.Getenv("DEVHUB_NEOVIM_GUI") != "":
		s.why("inside a Neovim DevHub draws (DEVHUB_NEOVIM_GUI)")
		return s.tui()
	case !isTerminal(os.Stdin) || !isTerminal(os.Stdout):
		s.why("stdin or stdout is not a terminal")
		return s.tui()
	case !s.editing():
		return s.tui()
	}
	tmp := os.Getenv("TMPDIR")
	if tmp == "" {
		tmp = "/tmp"
	}
	dir, err := os.MkdirTemp(tmp, "devhub-nvim.")
	if err != nil {
		s.why("no directory for its socket: %s", err)
		return s.tui()
	}
	s.dir = dir
	socket := filepath.Join(dir, "s")
	// Its stdin and stdout are the embedder's channel, which nothing uses: a
	// FIFO held open by Neovim itself (EOF there would end it) and /dev/null.
	fifo := filepath.Join(dir, "i")
	var input, null *os.File
	if err = syscall.Mkfifo(fifo, 0o600); err == nil {
		input, err = os.OpenFile(fifo, os.O_RDWR, 0)
	}
	if err == nil {
		null, err = os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	}
	if err != nil {
		os.RemoveAll(dir)
		s.why("no channel for its Neovim: %s", err)
		return s.tui()
	}
	// Ctrl-C, Ctrl-\ and Ctrl-Z typed at the pane under the GUI are not
	// Neovim's: its keys are the GUI's. A hangup (the pane killed) still ends
	// both. Ignored before Neovim starts, so it starts with them ignored too.
	signal.Ignore(syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTSTP)
	// The pane is asked and its socket named in one tmux client, while
	// Neovim starts: `--embed` waits for a UI before it reads the config or
	// a file, so a Neovim started for a pane that turns out not to be
	// DevHub's has done nothing that matters and is simply killed.
	claimed := make(chan error, 1)
	go func() { claimed <- s.nameSocket(socket) }()
	process, err := os.StartProcess(s.facts.Nvim,
		append([]string{s.facts.Nvim, "--embed", "--listen", socket}, s.args...),
		&os.ProcAttr{
			Env:   append(append([]string{}, s.env...), "DEVHUB_NEOVIM_GUI=1", nvimStateVariable+"="+dir),
			Files: []*os.File{input, null, os.Stderr},
		})
	input.Close()
	null.Close()
	if err != nil {
		<-claimed
		s.cleanup()
		s.why("its Neovim did not start: %s", err)
		return s.tui()
	}
	exited := make(chan int, 1)
	go func() {
		state, err := process.Wait()
		exited <- exitStatus(state, err)
	}()
	if err := <-claimed; err != nil {
		process.Kill()
		<-exited
		os.RemoveAll(dir)
		s.why("%s", err)
		return s.tui()
	}
	// Said in the pane too, for a DevHub in tmux control mode, which sees the
	// pane's bytes (tmux drops an OSC it does not know) — once the socket is
	// there, so DevHub's attach finds it listening.
	status, done := waitForSocket(socket, exited)
	os.Stdout.WriteString(nvimNamedOSC)
	if !done {
		status, done = s.waitForUI(exited)
		if !done && status < 0 {
			// No UI: it has read no config and opened no file (`--embed`
			// waits), so there is nothing to keep; SIGTERM would only have it
			// say "Caught deadly signal" in the pane.
			process.Kill()
			<-exited
			s.cleanup()
			wait := strconv.FormatFloat(float64(s.facts.UIWaitTenths)/10, 'f', -1, 64)
			s.why("no DevHub UI attached within %s s", wait)
			// Said once, dim, without DEVHUB_NVIM_DEBUG too: DevHub was asked
			// to draw this Neovim and did not, which is worth knowing (it stays
			// in the scrollback above the shell once the TUI's screen is gone).
			if !s.debug {
				fmt.Fprintf(os.Stderr, "\x1b[2m%s\x1b[22m\n", "nvim: DevHub did not draw it within "+wait+" s (DevHub not running, the terminal not on screen, or the overlay failed): running it in the terminal")
			}
			return s.tui()
		}
	}
	var keys *ttyKeys
	if !done {
		// What tmux writes into this pane is that Neovim's input.
		keys = s.startTTYKeys(socket)
		status = <-exited
	}
	// :restart: the server it started takes over on the same socket, the old
	// one's child and not this program's; the pane stays the Neovim's until
	// the last of them ends, with its status (neovimRestart.ts).
	status = followRestarts(dir, process.Pid, status)
	keys.stop()
	s.cleanup()
	return status
}

// nameSocket asks tmux, in one client, whether this pane is one DevHub draws
// over — the overlay on, a session of DevHub's, no `nvim` of DevHub's in it
// already — and if it is, names `socket` in it (`@devhub-nvim`).
func (s *nvimShim) nameSocket(socket string) error {
	if strings.ContainsAny(socket, "'\n") {
		return fmt.Errorf("its socket's path %q cannot be said to tmux", socket)
	}
	sessions := make([]string, 0, len(s.facts.SessionPrefixes))
	for _, prefix := range s.facts.SessionPrefixes {
		sessions = append(sessions, "#{m:"+formatEscape(prefix)+"*,#{session_name}}")
	}
	session := "0"
	for i, match := range sessions {
		if i == 0 {
			session = match
		} else {
			session = "#{||:" + session + "," + match + "}"
		}
	}
	condition := "#{&&:#{==:#{" + nvimOverlayOption + "},1},#{&&:#{==:#{" + nvimSocketOption + "},}," + session + "}}"
	state := "#{" + nvimOverlayOption + "}|#{session_name}|#{" + nvimSocketOption + "}|" + condition
	out, err := exec.Command(s.facts.Tmux,
		"display-message", "-p", "-t", s.pane, state, ";",
		"if-shell", "-F", "-t", s.pane, condition,
		"set-option -p -t "+s.pane+" "+nvimSocketOption+" '"+socket+"'",
	).Output()
	if err != nil {
		return fmt.Errorf("%s could not read pane %s (not DevHub's tmux server?)", s.facts.Tmux, s.pane)
	}
	line := strings.TrimRight(string(out), "\n")
	if strings.HasSuffix(line, "|1") {
		return nil
	}
	return fmt.Errorf("overlay|session|socket is %s (wants 1|%s...|empty)",
		strings.TrimSuffix(line, "|0"), strings.Join(s.facts.SessionPrefixes, " or "))
}

// formatEscape keeps a tmux format's own characters literal.
func formatEscape(text string) string {
	return strings.NewReplacer("#", "##", ",", "#,", "}", "#}").Replace(text)
}

// cleanup takes the pane's options back and removes the directory.
func (s *nvimShim) cleanup() {
	exec.Command(s.facts.Tmux,
		"set-option", "-p", "-u", "-t", s.pane, nvimSocketOption, ";",
		"set-option", "-p", "-u", "-t", s.pane, "@devhub-nvim-ui",
	).Run()
	os.RemoveAll(s.dir)
}

// waitForSocket waits until Neovim listens at `socket`, or has exited (its
// status, true), for at most a second.
func waitForSocket(socket string, exited <-chan int) (int, bool) {
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		select {
		case status := <-exited:
			return status, true
		default:
		}
		if info, err := os.Stat(socket); err == nil && info.Mode()&os.ModeSocket != 0 {
			return 0, false
		}
		time.Sleep(time.Millisecond)
	}
	return 0, false
}

// waitForUI waits for DevHub's UI: the file its attach writes in the
// directory (`ui`, `neovimUi.ts`). The status and true if Neovim exited
// first; -1 and false if the wait ran out.
func (s *nvimShim) waitForUI(exited <-chan int) (int, bool) {
	marker := filepath.Join(s.dir, "ui")
	deadline := time.Now().Add(time.Duration(s.facts.UIWaitTenths) * 100 * time.Millisecond)
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(marker); err == nil {
			return 0, false
		}
		if !time.Now().Before(deadline) {
			return -1, false
		}
		select {
		case status := <-exited:
			return status, true
		case <-tick.C:
		}
	}
}

// exitStatus is a shell's `$?` for a process that ended.
func exitStatus(state *os.ProcessState, err error) int {
	if err != nil || state == nil {
		return 1
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		return 128 + int(status.Signal())
	}
	return state.ExitCode()
}

// alive is `kill -0`.
func alive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

// followRestarts follows `:restart`s after the first server (`pid`) exited
// with `status` (`followRestartSh`): each new server by the pid DevHub's
// setup writes, the last one's status.
func followRestarts(dir string, pid, status int) int {
	read := func(name string) string {
		text, _ := os.ReadFile(filepath.Join(dir, name))
		return strings.TrimSpace(string(text))
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "restart")); err != nil {
			return status
		}
		os.Remove(filepath.Join(dir, "restart"))
		os.Remove(filepath.Join(dir, "exit"))
		next := 0
		for tries := 0; tries < nvimRestartWaitTenths; tries++ {
			if n, err := strconv.Atoi(read("pid")); err == nil && n != pid && alive(n) {
				next = n
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if next == 0 {
			return status
		}
		pid = next
		for alive(pid) {
			time.Sleep(200 * time.Millisecond)
		}
		if n, err := strconv.Atoi(read("exit")); err == nil && n >= 0 {
			status = n
		} else {
			status = 1
		}
	}
}

// ttyKeys is the tty reader (`terminalNeovimTtyKeys.ts`) and the tty's mode
// before it.
type ttyKeys struct {
	process *os.Process
	mode    syscall.Termios
}

// startTTYKeys puts the pane's tty in raw mode and runs the tty reader beside
// the Neovim, as `stty -icanon -echo -isig -ixon -ixoff -iexten -icrnl -inlcr
// -istrip min 1 time 0` and a bare `nvim -l` did; nil when the tty is not one.
func (s *nvimShim) startTTYKeys(socket string) *ttyKeys {
	if s.facts.Keys == "" {
		return nil
	}
	keys := &ttyKeys{}
	if termios(os.Stdin, ioctlGetTermios, &keys.mode) != nil {
		return nil
	}
	raw := keys.mode
	raw.Lflag &^= syscall.ICANON | syscall.ECHO | syscall.ISIG | syscall.IEXTEN
	raw.Iflag &^= syscall.IXON | syscall.IXOFF | syscall.ICRNL | syscall.INLCR | syscall.ISTRIP
	raw.Cc[syscall.VMIN] = 1
	raw.Cc[syscall.VTIME] = 0
	if termios(os.Stdin, ioctlSetTermios, &raw) != nil {
		return nil
	}
	// Bracketed paste and modifyOtherKeys, as Neovim's TUI asks for them.
	os.Stdout.WriteString("\x1b[?2004h\x1b[>4;2m")
	null, _ := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	process, err := os.StartProcess(s.facts.Nvim,
		[]string{s.facts.Nvim, "-u", "NONE", "-i", "NONE", "-n", "--headless", "-l", s.facts.Keys, socket, strconv.Itoa(os.Getpid())},
		&os.ProcAttr{Env: s.env, Files: []*os.File{os.Stdin, null, null}})
	if null != nil {
		null.Close()
	}
	if err == nil {
		keys.process = process
	}
	return keys
}

// stop ends the reader and gives the tty and tmux's modes back.
func (k *ttyKeys) stop() {
	if k == nil {
		return
	}
	if k.process != nil {
		k.process.Signal(syscall.SIGTERM)
		k.process.Wait()
	}
	os.Stdout.WriteString("\x1b[>4m\x1b[?2004l")
	termios(os.Stdin, ioctlSetTermios, &k.mode)
}

func termios(file *os.File, request uintptr, state *syscall.Termios) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), request, uintptr(unsafe.Pointer(state)))
	if errno != 0 {
		return errno
	}
	return nil
}
