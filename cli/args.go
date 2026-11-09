package main

import (
	"fmt"
	"strconv"
	"strings"
)

// Usage is what `devhub --help` prints.
const Usage = `devhub — drive the running DevHub from a terminal.

usage:
  devhub                           bring DevHub to the front
  devhub <folder>                  make the folder a workspace, show it, and
                                   bring DevHub to the front
  devhub <file>                    open the file in the workspace whose root
                                   contains it, or in the Scratch editor when
                                   no open workspace does
  devhub -                         open what is piped in as an editor, the way
                                   'code -' does; it lands in Scratch, like any
                                   other file no open workspace contains
  devhub -w|--wait <file>          open the file and do not return until its
                                   editor is closed again, so that this can be
                                   your EDITOR; closing it puts DevHub back
                                   where it was; combines with - and --goto
  devhub -g|--goto <file:line[:col]>
                                   open the file the same way and put the
                                   cursor on that line and column
  devhub --agent <profile> [-- <args>...]
                                   add an agent with that profile to the
                                   workspace containing the current directory
                                   and select it; <args> are appended to the
                                   profile's own arguments

  devhub -v|--version              print DevHub's version and the commit it
                                   was built from
  devhub --metrics                 print, as JSON, what the running DevHub is
                                   costing: every process's CPU and memory,
                                   and how often DevHub polls. Take two
                                   readings a known time apart to get a rate.
  devhub --tell <subcommand> ...   ask DevHub to do what its window does:
                                   list workspaces and agents, open a
                                   workspace, start an agent, hand it an
                                   Issue, read, message and answer agents.
                                   'devhub --tell help' lists them all
  devhub -h|--help                 show this text

The command talks to DevHub over its control socket. If DevHub is not running
it is started first, and the command then does what it was asked.`

// Hint follows every refusal, so nobody has to guess where the list is.
const Hint = "Run 'devhub --help' to see what devhub takes."

// Kind is what the arguments asked for.
type Kind int

const (
	KindUsage Kind = iota
	KindActivate
	KindOpenStdin
	KindInvalid
	KindOpen
	KindAddAgent
	KindVersion
	KindMetrics
	KindTell
)

// Position is where --goto puts the cursor, one-based.
type Position struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

// Command is one parsed command line.
type Command struct {
	Kind     Kind
	Message  string    // KindInvalid
	Path     string    // KindOpen
	Position *Position // KindOpen
	Wait     bool      // KindOpen, KindOpenStdin
	Profile  string    // KindAddAgent
	Args     []string  // KindAddAgent: the agent's; KindTell: everything after --tell
}

func invalid(message string) Command { return Command{Kind: KindInvalid, Message: message} }

// ParseArguments reads the command line the way the TypeScript CLI did:
// `--tell` first takes the rest verbatim (the app parses it), `--agent` must
// come first, and everything else is gathered in any order.
func ParseArguments(argv []string) Command {
	if len(argv) > 0 && argv[0] == "--tell" {
		return Command{Kind: KindTell, Args: append([]string{}, argv[1:]...)}
	}
	args := splitAssignments(argv)
	if len(args) == 0 {
		return Command{Kind: KindActivate}
	}
	if args[0] == "--help" || args[0] == "-h" {
		return Command{Kind: KindUsage}
	}
	if args[0] == "--agent" {
		return parseAgent(args[1:])
	}
	return parseOptions(args)
}

// `--option=value` is `--option value`.
func splitAssignments(argv []string) []string {
	out := make([]string, 0, len(argv))
	for _, arg := range argv {
		equals := -1
		if strings.HasPrefix(arg, "--") {
			equals = strings.Index(arg, "=")
		}
		if equals > 2 {
			out = append(out, arg[:equals], arg[equals+1:])
		} else {
			out = append(out, arg)
		}
	}
	return out
}

func parseAgent(rest []string) Command {
	if len(rest) == 0 || strings.HasPrefix(rest[0], "-") {
		return invalid("--agent needs the name of an agent profile.")
	}
	profile, args := rest[0], rest[1:]
	if len(args) == 0 {
		return Command{Kind: KindAddAgent, Profile: profile, Args: []string{}}
	}
	if args[0] != "--" {
		return invalid("arguments for the agent go after `--`, as in: devhub --agent claude -- --model opus.")
	}
	return Command{Kind: KindAddAgent, Profile: profile, Args: append([]string{}, args[1:]...)}
}

func parseOptions(args []string) Command {
	var paths []string
	var gotoSpec *string
	var stdin, wait, version, metrics bool
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch arg {
		case "-g", "--goto":
			index++
			if index >= len(args) || args[index] == "" {
				return invalid(arg + " needs a file, optionally with :line:column.")
			}
			value := args[index]
			gotoSpec = &value
		case "-w", "--wait":
			wait = true
		case "--metrics":
			metrics = true
		case "-v", "--version":
			version = true
		case "-h", "--help":
			return Command{Kind: KindUsage}
		case "-":
			stdin = true
		default:
			if strings.HasPrefix(arg, "-") {
				return invalid(fmt.Sprintf("devhub does not know the option '%s'.", arg))
			}
			paths = append(paths, arg)
		}
	}
	modes := 0
	for _, on := range []bool{version, metrics, gotoSpec != nil, stdin, len(paths) > 0} {
		if on {
			modes++
		}
	}
	if modes == 0 {
		if wait {
			return invalid("--wait waits for a file to be closed, so it needs a file to open.")
		}
		return invalid("devhub was not asked to do anything.")
	}
	if modes > 1 {
		return invalid("devhub does one of these things at a time.")
	}
	switch {
	case metrics:
		return Command{Kind: KindMetrics}
	case version:
		return Command{Kind: KindVersion}
	case stdin:
		return Command{Kind: KindOpenStdin, Wait: wait}
	case gotoSpec != nil:
		path, position, err := ParseFileAndPosition(*gotoSpec)
		if err != nil {
			return invalid(err.Error())
		}
		return Command{Kind: KindOpen, Path: path, Position: position, Wait: wait}
	case len(paths) > 1:
		return invalid("devhub opens one path at a time.")
	}
	return Command{Kind: KindOpen, Path: paths[0], Wait: wait}
}

const gotoFormat = "the format for --goto is FILE:LINE(:COLUMN), for example src/main.ts:42:7."

// ParseFileAndPosition splits FILE:LINE(:COLUMN). Segments that are not
// numbers belong to the path, so a path with colons in it survives; a
// missing column is column 1.
func ParseFileAndPosition(spec string) (string, *Position, error) {
	var path *string
	var line, column *float64
	for _, segment := range strings.Split(spec, ":") {
		number, ok := jsNumber(segment)
		switch {
		case !ok:
			if path == nil {
				s := segment
				path = &s
			} else {
				s := *path + ":" + segment
				path = &s
			}
		case line == nil:
			line = &number
		case column == nil:
			column = &number
		}
	}
	if path == nil || *path == "" {
		return "", nil, fmt.Errorf("%s", gotoFormat)
	}
	if line == nil {
		return *path, nil, nil
	}
	if !positiveInteger(*line) || (column != nil && !positiveInteger(*column)) {
		return "", nil, fmt.Errorf("%s", gotoFormat)
	}
	position := &Position{Line: int(*line), Column: 1}
	if column != nil {
		position.Column = int(*column)
	}
	return *path, position, nil
}

// jsNumber is JavaScript's Number(segment) followed by isFinite: what the
// TypeScript CLI counted as a number, kept so that `devhub -g` reads the
// same specs the same way (an empty segment is 0, not a path).
func jsNumber(segment string) (float64, bool) {
	trimmed := strings.TrimSpace(segment)
	if trimmed == "" {
		return 0, true
	}
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"0x", "0o", "0b"} {
		if strings.HasPrefix(lower, prefix) {
			value, err := strconv.ParseInt(trimmed[2:], map[string]int{"0x": 16, "0o": 8, "0b": 2}[prefix], 64)
			return float64(value), err == nil
		}
	}
	if strings.ContainsAny(lower, "infa_") { // Infinity, NaN, hex floats, Go's 1_000
		return 0, false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	return value, err == nil
}

func positiveInteger(value float64) bool {
	return value >= 1 && value == float64(int64(value))
}
