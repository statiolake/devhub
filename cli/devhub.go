package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// ExpandPath is resolve.ts's expandPath: ~ and ~/ against home, a relative
// path against cwd, as strings (the path may be on another machine's disk).
func ExpandPath(raw, cwd, home string) string {
	expanded := raw
	if raw == "~" {
		expanded = home
	} else if strings.HasPrefix(raw, "~/") {
		expanded = home + "/" + raw[2:]
	}
	if strings.HasPrefix(expanded, "/") {
		return expanded
	}
	return cwd + "/" + expanded
}

// Caller is what DevHub stated about the pane this runs in.
type Caller struct {
	Origin  string // DEVHUB_ORIGIN
	Machine string // DEVHUB_MACHINE
}

// RequestFor is the control request for a parsed command.
func RequestFor(command Command, cwd, home, marker string, caller Caller) (Request, bool) {
	switch command.Kind {
	case KindActivate:
		return Request{Kind: "activate"}, true
	case KindOpen:
		return Request{
			Kind: "open", Path: ExpandPath(command.Path, cwd, home), Cwd: cwd,
			Machine: caller.Machine, Origin: caller.Origin,
			Position: command.Position, WaitMarkerPath: marker,
		}, true
	case KindAddAgent:
		args := command.Args
		if args == nil {
			args = []string{}
		}
		return Request{Kind: "add-agent", ProfileID: command.Profile, Args: &args, Cwd: cwd}, true
	case KindVersion:
		return Request{Kind: "version"}, true
	case KindMetrics:
		return Request{Kind: "metrics"}, true
	case KindTell:
		// The app parses the words: one parser, beside the code that runs them.
		return Request{
			Kind: "tell", Argv: command.Args, Cwd: cwd, Home: home,
			Machine: caller.Machine, Origin: caller.Origin,
		}, true
	}
	return Request{}, false
}

// isTerminal is isatty(3), as Node's isTTY is: /dev/null is a character
// device and not a terminal, so `devhub --tell … - < /dev/null` sends empty
// text rather than refusing.
func isTerminal(file *os.File) bool {
	var state syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, file.Fd(), ioctlGetTermios, uintptr(unsafe.Pointer(&state)))
	return errno == 0
}

// IO is where devhubMain reads and writes, so tests can drive it.
type IO struct {
	Stdin         io.Reader
	StdinTerminal bool
	Stdout        io.Writer
	Stderr        io.Writer
	Cwd           string
	Home          string
	TempDir       string
}

func devhubMain(argv []string, env map[string]string) int {
	cwd, _ := os.Getwd()
	home, _ := os.UserHomeDir()
	return Run(argv, env, IO{
		Stdin: os.Stdin, StdinTerminal: isTerminal(os.Stdin),
		Stdout: os.Stdout, Stderr: os.Stderr,
		Cwd: cwd, Home: home, TempDir: os.TempDir(),
	}, os.Environ())
}

// Run is the whole `devhub` command.
func Run(argv []string, env map[string]string, io_ IO, processEnv []string) int {
	command := ParseArguments(argv)
	switch command.Kind {
	case KindUsage:
		fmt.Fprintln(io_.Stdout, Usage)
		return 0
	case KindInvalid:
		fmt.Fprintf(io_.Stderr, "devhub: %s\n%s\n", command.Message, Hint)
		return 2
	}
	if command.Kind == KindOpenStdin {
		if io_.StdinTerminal {
			fmt.Fprintf(io_.Stderr, "devhub: 'devhub -' opens what is piped into it, and nothing is piped into this one. Try: echo hello | devhub -\n%s\n", Hint)
			return 2
		}
		spool, err := SpoolStdin(io_.Stdin, io_.TempDir)
		if err != nil {
			fmt.Fprintf(io_.Stderr, "devhub: %s\n", err)
			return 1
		}
		command = Command{Kind: KindOpen, Path: spool, Wait: command.Wait}
	}
	socketPath := env["DEVHUB_CONTROL_SOCKET"]
	if socketPath == "" {
		fmt.Fprintf(io_.Stderr, "DEVHUB_CONTROL_SOCKET is not set. Run %s to write a launcher that sets it.\n", InstallCommandHint)
		return 1
	}
	caller := Caller{Origin: env["DEVHUB_ORIGIN"], Machine: env["DEVHUB_MACHINE"]}
	var launcher Launcher
	if caller.Machine == "" || caller.Machine == "local" {
		launch, err := ParseLaunchCommand(env[LaunchCommandVariable])
		if err != nil {
			fmt.Fprintln(io_.Stderr, err)
			return 1
		}
		launcher = CommandLauncher(socketPath, launch, processEnv)
	} else {
		launcher = ForwardedSocketLauncher(socketPath, caller.Machine)
	}
	marker := ""
	if command.Kind == KindOpen && command.Wait {
		made, err := CreateMarker(io_.TempDir)
		if err != nil {
			fmt.Fprintf(io_.Stderr, "devhub: %s\n", err)
			return 1
		}
		marker = made
		defer RemoveMarker(marker)
	}
	code, err := send(command, socketPath, launcher, caller, marker, io_)
	if err != nil {
		fmt.Fprintf(io_.Stderr, "devhub: %s\n", err)
		return 1
	}
	return code
}

func send(command Command, socketPath string, launcher Launcher, caller Caller, marker string, io_ IO) (int, error) {
	request, ok := RequestFor(command, io_.Cwd, io_.Home, marker, caller)
	if !ok {
		return 2, nil
	}
	response, err := SendOrLaunch(func() (Response, error) { return Ask(socketPath, request) }, launcher)
	if err != nil {
		return 1, err
	}
	// The app read the words. A `-` in them is text, or they name files
	// (`--attach`): what is piped in, and those files, are read now, here —
	// on the host, for a command run on one — and only now, and the request
	// goes again with them. Each is asked for at most once.
	for asked := 0; command.Kind == KindTell && !response.OK && asked < 2; asked++ {
		switch {
		case response.Stdin && request.Stdin == nil:
			if io_.StdinTerminal {
				fmt.Fprintln(io_.Stderr, "devhub: '-' reads the text from what is piped in, and nothing is.")
				return 2, nil
			}
			text, err := io.ReadAll(io_.Stdin)
			if err != nil {
				return 1, err
			}
			piped := string(text)
			request.Stdin = &piped
		case len(response.Files) > 0 && request.Files == nil:
			files, err := ReadAttachments(response.Files)
			if err != nil {
				fmt.Fprintf(io_.Stderr, "devhub: --attach: %s\n", err)
				return 1, nil
			}
			request.Files = files
		default:
			asked = 2
			continue
		}
		if response, err = Ask(socketPath, request); err != nil {
			return 1, err
		}
	}
	if command.Kind == KindTell {
		return printTell(response, io_), nil
	}
	if !response.OK {
		fmt.Fprintln(io_.Stderr, response.Message)
		return 1, nil
	}
	if marker == "" {
		fmt.Fprintln(io_.Stdout, response.Message)
		return 0, nil
	}
	// Nothing is printed for a --wait: this is somebody's EDITOR. The
	// report is the exit status, and the file.
	if err := WaitForClose(MarkerWorld(marker, socketPath)); err != nil {
		return 1, err
	}
	ended, err := Ask(socketPath, Request{Kind: "wait-ended", WaitMarkerPath: marker})
	if err != nil {
		// The edit happened; `git commit` reads this status. Say it, on the
		// stream nobody parses, and succeed.
		fmt.Fprintf(io_.Stderr, "devhub: %s\n", err)
	} else if !ended.OK {
		fmt.Fprintln(io_.Stderr, ended.Message)
	}
	return 0, nil
}

// printTell prints a tell answer the way the TypeScript CLI did: with
// --json, `{"ok": true, ...data}` indented by two (or `{"ok":false,
// "error":…}` on stdout and the sentence on stderr); otherwise the sentence.
func printTell(response Response, io_ IO) int {
	if !response.OK {
		if response.Usage {
			fmt.Fprintf(io_.Stderr, "devhub: --tell: %s\n%s\n", response.Message, Hint)
			return 2
		}
		if response.JSON {
			line, _ := encodeLine(struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			}{false, response.Message})
			io_.Stdout.Write(line)
		}
		fmt.Fprintln(io_.Stderr, response.Message)
		return 1
	}
	if !response.JSON {
		fmt.Fprintln(io_.Stdout, response.Message)
		return 0
	}
	fmt.Fprintln(io_.Stdout, okWith(response.Data))
	return 0
}

// okWith puts "ok": true in front of the data's own keys, in their order,
// as JSON.stringify({ ok: true, ...data }, null, 2) does; data that is not
// an object is { ok: true, data }.
func okWith(data json.RawMessage) string {
	trimmed := bytes.TrimSpace(data)
	var joined []byte
	switch {
	case len(trimmed) > 0 && trimmed[0] == '{':
		inner := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
		joined = []byte(`{"ok":true`)
		if len(inner) > 0 {
			joined = append(append(joined, ','), inner...)
		}
		joined = append(joined, '}')
	case len(trimmed) == 0:
		joined = []byte(`{"ok":true}`)
	default:
		joined = append(append([]byte(`{"ok":true,"data":`), trimmed...), '}')
	}
	var out bytes.Buffer
	if err := json.Indent(&out, joined, "", "  "); err != nil {
		return string(joined)
	}
	return out.String()
}
