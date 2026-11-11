package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeDevhub answers the control socket the way the app does: one JSON line
// in, one out, then close. answer sees every request but pings.
func fakeDevhub(t *testing.T, socketPath string, answer func(map[string]any) map[string]any) (requests func() []map[string]any) {
	t.Helper()
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	seen := make(chan map[string]any, 64)
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				line, err := bufio.NewReader(connection).ReadBytes('\n')
				if err != nil {
					return
				}
				var request map[string]any
				_ = json.Unmarshal(line, &request)
				if request["kind"] == "ping" {
					connection.Write([]byte("{\"ok\":true,\"message\":\"pong\"}\n"))
					return
				}
				seen <- request
				reply, _ := json.Marshal(answer(request))
				connection.Write(append(reply, '\n'))
			}()
		}
	}()
	return func() []map[string]any {
		var all []map[string]any
		for {
			select {
			case request := <-seen:
				all = append(all, request)
			default:
				return all
			}
		}
	}
}

func shortSocket(t *testing.T) string {
	// sun_path is short on macOS; t.TempDir() can be too long for it.
	directory, err := os.MkdirTemp("", "dh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(directory) })
	return filepath.Join(directory, "control.sock")
}

func run(t *testing.T, argv []string, env map[string]string, stdin string, terminal bool) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := Run(argv, env, IO{
		Stdin: strings.NewReader(stdin), StdinTerminal: terminal,
		Stdout: &stdout, Stderr: &stderr,
		Cwd: "/work/repo", Home: "/home/u", TempDir: t.TempDir(),
	}, nil)
	return code, stdout.String(), stderr.String()
}

func localEnv(socket string) map[string]string {
	return map[string]string{"DEVHUB_CONTROL_SOCKET": socket, LaunchCommandVariable: `["/bin/false"]`}
}

func TestOpenCarriesThePane(t *testing.T) {
	socket := shortSocket(t)
	requests := fakeDevhub(t, socket, func(map[string]any) map[string]any {
		return map[string]any{"ok": true, "message": "Opened a.txt."}
	})
	env := localEnv(socket)
	env["DEVHUB_ORIGIN"] = "local\tws1\tnone"
	code, stdout, _ := run(t, []string{"-g", "a.txt:3"}, env, "", true)
	if code != 0 || stdout != "Opened a.txt.\n" {
		t.Fatalf("code %d stdout %q", code, stdout)
	}
	got := requests()[0]
	want := map[string]any{"kind": "open", "path": "/work/repo/a.txt", "cwd": "/work/repo", "origin": "local\tws1\tnone", "position": map[string]any{"line": 3.0, "column": 1.0}}
	if !jsonEqual(got, want) {
		t.Errorf("sent %v, want %v", got, want)
	}
}

func TestWaitReturnsOnceTheMarkerGoes(t *testing.T) {
	socket := shortSocket(t)
	requests := fakeDevhub(t, socket, func(request map[string]any) map[string]any {
		if marker, ok := request["waitMarkerPath"].(string); ok && request["kind"] == "open" {
			go func() { time.Sleep(300 * time.Millisecond); os.Remove(marker) }()
		}
		return map[string]any{"ok": true, "message": "ignored"}
	})
	code, stdout, stderr := run(t, []string{"--wait", "/w/COMMIT_EDITMSG"}, localEnv(socket), "", true)
	if code != 0 || stdout != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	sent := requests()
	if len(sent) != 2 || sent[1]["kind"] != "wait-ended" || sent[1]["waitMarkerPath"] != sent[0]["waitMarkerPath"] {
		t.Errorf("sent %v", sent)
	}
	if _, err := os.Stat(filepath.Dir(sent[0]["waitMarkerPath"].(string))); !os.IsNotExist(err) {
		t.Errorf("the marker's directory is still there")
	}
}

func TestWaitFailsWhenDevhubGoes(t *testing.T) {
	socket := shortSocket(t)
	var listener net.Listener
	listener, _ = net.Listen("unix", socket)
	go func() {
		connection, _ := listener.Accept()
		bufio.NewReader(connection).ReadBytes('\n')
		connection.Write([]byte("{\"ok\":true,\"message\":\"\"}\n"))
		connection.Close()
		listener.Close() // DevHub quits with the file still open
	}()
	code, _, stderr := run(t, []string{"-w", "/w/x"}, localEnv(socket), "", true)
	if code != 1 || !strings.Contains(stderr, "stopped while the file was still open") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestStdinIsSpooledAndOpened(t *testing.T) {
	socket := shortSocket(t)
	var spooled string
	fakeDevhub(t, socket, func(request map[string]any) map[string]any {
		text, _ := os.ReadFile(request["path"].(string))
		spooled = string(text)
		return map[string]any{"ok": true, "message": "ok"}
	})
	if code, _, _ := run(t, []string{"-"}, localEnv(socket), "hello\n", false); code != 0 || spooled != "hello\n" {
		t.Errorf("code %d spooled %q", code, spooled)
	}
	if code, _, stderr := run(t, []string{"-"}, localEnv(socket), "", true); code != 2 || !strings.Contains(stderr, "nothing is piped") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestTellSendsTheWordsAndPrintsJSON(t *testing.T) {
	socket := shortSocket(t)
	requests := fakeDevhub(t, socket, func(request map[string]any) map[string]any {
		if _, piped := request["stdin"]; !piped {
			return map[string]any{"ok": false, "stdin": true, "message": "send stdin"}
		}
		return map[string]any{"ok": true, "message": "Sent.", "json": true, "data": map[string]any{"agent": "a1"}}
	})
	env := localEnv(socket)
	env["DEVHUB_MACHINE"] = "ssh:box"
	code, stdout, _ := run(t, []string{"--tell", "--json", "agent", "send", "a1", "-"}, env, "long text\n", false)
	if code != 0 || stdout != "{\n  \"ok\": true,\n  \"agent\": \"a1\"\n}\n" {
		t.Fatalf("code %d stdout %q", code, stdout)
	}
	words := []any{"--json", "agent", "send", "a1", "-"}
	sent := requests()
	first := map[string]any{"kind": "tell", "argv": words, "cwd": "/work/repo", "home": "/home/u", "machine": "ssh:box"}
	second := map[string]any{"kind": "tell", "argv": words, "cwd": "/work/repo", "home": "/home/u", "machine": "ssh:box", "stdin": "long text\n"}
	if len(sent) != 2 || !jsonEqual(sent[0], first) || !jsonEqual(sent[1], second) {
		t.Errorf("sent %v", sent)
	}
}

// The pipe is read only when the app says a `-` is text: a `devhub --tell`
// whose stdin is a terminal (or a pipe nobody closes) never waits on it.
func TestTellReadsNoStdinUnlessAsked(t *testing.T) {
	socket := shortSocket(t)
	requests := fakeDevhub(t, socket, func(map[string]any) map[string]any {
		return map[string]any{"ok": true, "message": "2 agents", "json": false}
	})
	blocking, _ := io.Pipe()
	var stdout bytes.Buffer
	code := Run([]string{"--tell", "agents"}, localEnv(socket), IO{
		Stdin: blocking, Stdout: &stdout, Stderr: io.Discard,
		Cwd: "/w", Home: "/h", TempDir: t.TempDir(),
	}, nil)
	if code != 0 || stdout.String() != "2 agents\n" || len(requests()) != 1 {
		t.Errorf("code %d stdout %q", code, stdout.String())
	}
}

func TestTellRefusals(t *testing.T) {
	socket := shortSocket(t)
	fakeDevhub(t, socket, func(request map[string]any) map[string]any {
		switch request["argv"].([]any)[0] {
		case "nope":
			return map[string]any{"ok": false, "usage": true, "message": "unknown subcommand nope."}
		case "agent":
			return map[string]any{"ok": false, "stdin": true, "message": "send stdin"}
		}
		return map[string]any{"ok": false, "json": true, "message": "no such agent."}
	})
	code, _, stderr := run(t, []string{"--tell", "nope"}, localEnv(socket), "", true)
	if code != 2 || stderr != "devhub: --tell: unknown subcommand nope.\n"+Hint+"\n" {
		t.Errorf("code %d stderr %q", code, stderr)
	}
	code, stdout, stderr := run(t, []string{"--tell", "--json", "read", "x"}, localEnv(socket), "", true)
	if code != 1 || stdout != "{\"ok\":false,\"error\":\"no such agent.\"}\n" || stderr != "no such agent.\n" {
		t.Errorf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	code, _, stderr = run(t, []string{"--tell", "agent", "send", "a", "-"}, localEnv(socket), "", true)
	if code != 2 || !strings.Contains(stderr, "nothing is") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestLaunchesDevhubWhenNothingAnswers(t *testing.T) {
	socket := shortSocket(t)
	started := false
	launcher := systemLauncher(socket)
	launcher.Description = "test"
	launcher.CannotStart = func(reason string) string { return reason }
	launcher.Open = func() error {
		started = true
		fakeDevhub(t, socket, func(map[string]any) map[string]any { return map[string]any{"ok": true, "message": "up"} })
		return nil
	}
	launcher.Pause = func(time.Duration) { time.Sleep(10 * time.Millisecond) }
	response, err := SendOrLaunch(func() (Response, error) { return Ask(socket, Request{Kind: "activate"}) }, launcher)
	if err != nil || !started || response.Message != "up" {
		t.Errorf("started %v response %+v err %v", started, response, err)
	}
}

func TestAHostCannotStartDevhub(t *testing.T) {
	socket := shortSocket(t)
	env := map[string]string{"DEVHUB_CONTROL_SOCKET": socket, "DEVHUB_MACHINE": "ssh:box"}
	code, _, stderr := run(t, []string{"."}, env, "", true)
	if code != 1 || !strings.Contains(stderr, "cannot be started from here") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestALauncherWithoutALaunchCommand(t *testing.T) {
	code, _, stderr := run(t, []string{"."}, map[string]string{"DEVHUB_CONTROL_SOCKET": "/nowhere"}, "", true)
	if code != 1 || !strings.Contains(stderr, LaunchCommandVariable+" is not set") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

func TestDevNullIsNotATerminal(t *testing.T) {
	null, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	if isTerminal(null) {
		t.Error("/dev/null was taken for a terminal")
	}
}

// `--attach`: the app names the files, the command reads them where it runs
// (on the host, for a command run on one) and asks again with their bytes.
func TestTellSendsTheFilesItIsAskedFor(t *testing.T) {
	socket := shortSocket(t)
	shot := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(shot, []byte("\x89PNG\r\n\x1a\nbytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	requests := fakeDevhub(t, socket, func(request map[string]any) map[string]any {
		if _, piped := request["stdin"]; !piped {
			return map[string]any{"ok": false, "stdin": true, "message": "send stdin"}
		}
		if _, sent := request["files"]; !sent {
			return map[string]any{"ok": false, "files": []string{shot}, "message": "send the files"}
		}
		return map[string]any{"ok": true, "message": "Raised #1."}
	})
	env := localEnv(socket)
	env["DEVHUB_MACHINE"] = "ssh:box"
	words := []string{"--tell", "escalation", "new", "--title", "t", "--body", "-", "--attach", shot}
	code, stdout, stderr := run(t, words, env, "body\n", false)
	if code != 0 || stdout != "Raised #1.\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	sent := requests()
	if len(sent) != 3 {
		t.Fatalf("sent %d requests: %v", len(sent), sent)
	}
	files, _ := sent[2]["files"].(map[string]any)
	if sent[2]["stdin"] != "body\n" || files[shot] != "iVBORw0KGgpieXRlcw==" {
		t.Errorf("last request %v", sent[2])
	}
}

func TestTellRefusesFilesItCannotSend(t *testing.T) {
	socket := shortSocket(t)
	directory := t.TempDir()
	big := filepath.Join(directory, "big.png")
	if err := os.WriteFile(big, make([]byte, MaxAttachment+1), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ path, says string }{
		{filepath.Join(directory, "gone.png"), "is not there"},
		{directory, "is not a file"},
		{big, "a file is at most 10 MB"},
	} {
		requests := fakeDevhub(t, socket, func(map[string]any) map[string]any {
			return map[string]any{"ok": false, "files": []string{c.path}, "message": "send the files"}
		})
		code, _, stderr := run(t, []string{"--tell", "attachment", "add", c.path}, localEnv(socket), "", true)
		if code != 1 || !strings.Contains(stderr, "devhub: --attach: ") || !strings.Contains(stderr, c.says) {
			t.Errorf("%s: code %d stderr %q", c.path, code, stderr)
		}
		if sent := requests(); len(sent) != 1 {
			t.Errorf("%s: sent %v", c.path, sent)
		}
		os.Remove(socket)
	}
}
