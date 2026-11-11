package main

import (
	"bytes"
	"os"
	"testing"
)

// testdata/requests.jsonl is every request shape this command sends, one per
// line, exactly as it sends them. The app's suite reads the same file and
// requires parseControlRequest to accept each line as it is
// (src/main/cli/protocol.fixture.test.ts): the two halves of the protocol
// are checked against one statement of it.
func TestRequestFixture(t *testing.T) {
	position := &Position{Line: 3, Column: 7}
	piped := "text\n"
	caller := Caller{Origin: "ssh:box\tw1\tA1", Machine: "ssh:box"}
	var lines [][]byte
	add := func(request Request) {
		line, err := encodeLine(request)
		if err != nil {
			t.Fatal(err)
		}
		lines = append(lines, line)
	}
	for _, command := range []Command{
		{Kind: KindActivate},
		{Kind: KindOpen, Path: "src/a.ts", Position: position},
		{Kind: KindAddAgent, Profile: "claude", Args: []string{"--model", "x"}},
		{Kind: KindAddAgent, Profile: "claude"},
		{Kind: KindVersion},
		{Kind: KindMetrics},
		{Kind: KindTell, Args: []string{"--json", "agents"}},
	} {
		request, ok := RequestFor(command, "/work", "/home/u", "", Caller{})
		if !ok {
			t.Fatalf("no request for %+v", command)
		}
		add(request)
	}
	open, _ := RequestFor(Command{Kind: KindOpen, Path: "~/notes.md"}, "/work", "/home/u", "/tmp/devhub-wait-0a/marker", caller)
	add(open)
	tell, _ := RequestFor(Command{Kind: KindTell, Args: []string{"agent", "send", "A1", "-"}}, "/srv/app", "/home/u", "", caller)
	tell.Stdin = &piped
	add(tell)
	attach, _ := RequestFor(Command{Kind: KindTell, Args: []string{"attachment", "add", "shot.png"}}, "/srv/app", "/home/u", "", caller)
	attach.Files = map[string]string{"/srv/app/shot.png": "iVBORw0KGgo="}
	add(attach)
	add(Request{Kind: "wait-ended", WaitMarkerPath: "/tmp/devhub-wait-0a/marker"})
	add(Request{Kind: "ping"})
	got := bytes.Join(lines, nil)
	if os.Getenv("DEVHUB_UPDATE_FIXTURE") == "1" {
		if err := os.WriteFile("testdata/requests.jsonl", got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile("testdata/requests.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("the requests changed; if on purpose, rerun with DEVHUB_UPDATE_FIXTURE=1 and update the app's side too.\ngot:\n%s\nwant:\n%s", got, want)
	}
}
