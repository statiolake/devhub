package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The text `--tell` was asked for goes on the connection that asked: the app
// keeps it open for that, and a second connection over a host's forwarded
// socket is a second ssh channel and a round trip.
func TestTellAsksAgainOnTheSameConnection(t *testing.T) {
	socket := shortSocket(t)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var connections atomic.Int32
	var lines []map[string]any
	done := make(chan struct{})
	serve := func(connection net.Conn) {
		defer close(done)
		defer connection.Close()
		reader := bufio.NewReader(connection)
		for _, reply := range []string{
			`{"ok":false,"message":"send it","stdin":true}`,
			`{"ok":true,"message":"sent","json":false}`,
		} {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var request map[string]any
			_ = json.Unmarshal(line, &request)
			lines = append(lines, request)
			connection.Write([]byte(reply + "\n"))
		}
	}
	go func() {
		// The first connection is answered; any further one is counted, and
		// refused.
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			if connections.Add(1) == 1 {
				go serve(connection)
			} else {
				connection.Close()
			}
		}
	}()
	code, stdout, stderr := run(t, []string{"--tell", "agent", "send", "A1", "-"}, localEnv(socket), "hello\n", false)
	<-done
	if code != 0 || stdout != "sent\n" {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	if connections.Load() != 1 || len(lines) != 2 || lines[1]["stdin"] != "hello\n" || lines[0]["stdin"] != nil {
		t.Errorf("%d connections, requests %v", connections.Load(), lines)
	}
}

// A start that fails is said when it fails, not after the poll it fell in.
func TestAFailedStartIsSaidAtOnce(t *testing.T) {
	release := make(chan struct{})
	launcher := Launcher{
		SocketPath:  "/nowhere",
		Description: "test",
		CannotStart: func(reason string) string { return "cannot: " + reason },
		Open: func() error {
			<-release
			return errors.New("no")
		},
		Answers: func() bool { return false },
		// A poll that would outlast the test: only the failure ends it.
		Pause: func(_ time.Duration, failed <-chan error) error { return pauseOrFail(time.Hour, failed) },
		Now:   time.Now,
	}
	result := make(chan error, 1)
	go func() { result <- LaunchAndWait(launcher) }()
	close(release)
	select {
	case err := <-result:
		if err == nil || err.Error() != "cannot: no" {
			t.Errorf("err %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the failed start was not said")
	}
}

// The socket is looked at every LaunchPoll while DevHub starts.
func TestTheLaunchPollIsShort(t *testing.T) {
	var polls []time.Duration
	answers := 0
	launcher := Launcher{
		SocketPath: "/nowhere", Description: "test",
		CannotStart: func(reason string) string { return reason },
		Open:        func() error { return nil },
		Answers:     func() bool { answers++; return answers > 3 },
		Pause: func(poll time.Duration, _ <-chan error) error {
			polls = append(polls, poll)
			return nil
		},
		Now: time.Now,
	}
	if err := LaunchAndWait(launcher); err != nil {
		t.Fatal(err)
	}
	if len(polls) != 3 || polls[0] != 20*time.Millisecond || polls[2] != polls[0] {
		t.Errorf("polls %v", polls)
	}
}

// --wait looks at its marker every poll and pings DevHub every
// WaitPingEvery of them.
func TestWaitPingsLessOftenThanItLooks(t *testing.T) {
	looks, pings := 0, 0
	err := WaitForClose(WaitWorld{
		MarkerExists:  func() bool { looks++; return looks <= 20 },
		DevhubAnswers: func() bool { pings++; return true },
		Pause:         func(time.Duration) {},
	})
	if err != nil || looks != 21 || pings != 3 {
		t.Errorf("err %v looks %d pings %d", err, looks, pings)
	}
}

func TestTraceSaysEachStage(t *testing.T) {
	socket := shortSocket(t)
	fakeDevhub(t, socket, func(map[string]any) map[string]any {
		return map[string]any{"ok": true, "message": "DevHub 1"}
	})
	startTrace(map[string]string{TraceVariable: "1"}, time.Now())
	defer func() { trace = nil }()
	if _, err := Ask(socket, Request{Kind: "version"}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writeTrace(&out)
	line := out.String()
	for _, stage := range []string{"devhub-trace: connected=", " written=", " answered=", " exit="} {
		if !strings.Contains(line, stage) {
			t.Errorf("%q has no %q", line, stage)
		}
	}
	startTrace(map[string]string{}, time.Now())
	out.Reset()
	writeTrace(&out)
	if out.Len() != 0 {
		t.Errorf("traced while off: %q", out.String())
	}
}
