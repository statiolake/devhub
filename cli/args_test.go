package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseArguments(t *testing.T) {
	cases := []struct {
		argv []string
		want Command
	}{
		{nil, Command{Kind: KindActivate}},
		{[]string{"src"}, Command{Kind: KindOpen, Path: "src"}},
		{[]string{"--agent", "claude"}, Command{Kind: KindAddAgent, Profile: "claude", Args: []string{}}},
		{[]string{"--agent", "claude", "--", "--help", "-w"}, Command{Kind: KindAddAgent, Profile: "claude", Args: []string{"--help", "-w"}}},
		{[]string{"-"}, Command{Kind: KindOpenStdin}},
		{[]string{"-w", "-"}, Command{Kind: KindOpenStdin, Wait: true}},
		{[]string{"--wait", "a.txt"}, Command{Kind: KindOpen, Path: "a.txt", Wait: true}},
		{[]string{"--goto", "src/a.ts:42:7"}, Command{Kind: KindOpen, Path: "src/a.ts", Position: &Position{42, 7}}},
		{[]string{"-g", "src/a.ts:42", "-w"}, Command{Kind: KindOpen, Path: "src/a.ts", Position: &Position{42, 1}, Wait: true}},
		{[]string{"--goto=src/a.ts"}, Command{Kind: KindOpen, Path: "src/a.ts"}},
		{[]string{"--goto", "/w/a:b/c.ts:3"}, Command{Kind: KindOpen, Path: "/w/a:b/c.ts", Position: &Position{3, 1}}},
		{[]string{"-v"}, Command{Kind: KindVersion}},
		{[]string{"--metrics"}, Command{Kind: KindMetrics}},
		{[]string{"--help"}, Command{Kind: KindUsage}},
		{[]string{"a", "--help"}, Command{Kind: KindUsage}},
		{[]string{"--tell", "agent", "send", "x", "--wait", "-"}, Command{Kind: KindTell, Args: []string{"agent", "send", "x", "--wait", "-"}}},
	}
	for _, c := range cases {
		if got := ParseArguments(c.argv); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ParseArguments(%q) = %+v, want %+v", c.argv, got, c.want)
		}
	}
}

func TestParseArgumentsRefuses(t *testing.T) {
	cases := map[string][]string{
		"--agent needs the name":                         {"--agent"},
		"arguments for the agent go after `--`":          {"--agent", "claude", "--model"},
		"needs a file to open":                           {"--wait"},
		"one of these things at a time":                  {"-v", "--metrics"},
		"opens one path at a time":                       {"a", "b"},
		"does not know the option '--install-extension'": {"--install-extension", "a.b"},
		"--goto needs a file":                            {"--goto"},
		"FILE:LINE":                                      {"--goto", "a.ts:0"},
	}
	for want, argv := range cases {
		got := ParseArguments(argv)
		if got.Kind != KindInvalid || !strings.Contains(got.Message, want) {
			t.Errorf("ParseArguments(%q) = %+v, want a refusal saying %q", argv, got, want)
		}
	}
}

func TestParseFileAndPosition(t *testing.T) {
	path, position, err := ParseFileAndPosition("/w/odd:name/a.ts:3:4")
	if err != nil || path != "/w/odd:name/a.ts" || *position != (Position{3, 4}) {
		t.Errorf("got %q %v %v", path, position, err)
	}
	path, position, err = ParseFileAndPosition("/w/odd:name/a.ts")
	if err != nil || path != "/w/odd:name/a.ts" || position != nil {
		t.Errorf("got %q %v %v", path, position, err)
	}
	for _, spec := range []string{"a.ts:", "a.ts:0", "a.ts:-3", "a.ts:2.5", "a.ts:3:0", "12"} {
		if _, _, err := ParseFileAndPosition(spec); err == nil || !strings.Contains(err.Error(), "FILE:LINE") {
			t.Errorf("ParseFileAndPosition(%q) did not refuse: %v", spec, err)
		}
	}
}

func TestExpandPath(t *testing.T) {
	for raw, want := range map[string]string{
		"~": "/home/u", "~/x": "/home/u/x", "/abs": "/abs", "rel/x": "/w/rel/x", "~x": "/w/~x",
	} {
		if got := ExpandPath(raw, "/w", "/home/u"); got != want {
			t.Errorf("ExpandPath(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestOkWith(t *testing.T) {
	cases := map[string]string{
		`{"b":1,"a":[2]}`: "{\n  \"ok\": true,\n  \"b\": 1,\n  \"a\": [\n    2\n  ]\n}",
		`{}`:              "{\n  \"ok\": true\n}",
		``:                "{\n  \"ok\": true\n}",
		`[1]`:             "{\n  \"ok\": true,\n  \"data\": [\n    1\n  ]\n}",
		`{"s":"<é>"}`:     "{\n  \"ok\": true,\n  \"s\": \"<é>\"\n}",
	}
	for data, want := range cases {
		if got := okWith([]byte(data)); got != want {
			t.Errorf("okWith(%s) = %s, want %s", data, got, want)
		}
	}
}
