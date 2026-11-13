package main

import (
	"fmt"
	"io"
	"strings"
	"time"
)

// TraceVariable turns on the per-stage timings `scripts/bench-cli.sh` reads:
// with it set to 1, the command writes one line to stderr as it exits,
//
//	devhub-trace: dial=0.08 connected=0.15 written=0.17 answered=2.31 exit=2.40
//
// each a stage's end in milliseconds since main began. A second request on the
// same command (the text or files `--tell` was asked for, a `--wait`'s end)
// adds its stages again with `#2`, `#3`. Off, nothing is timed or written.
const TraceVariable = "DEVHUB_TRACE"

type traceMark struct {
	stage string
	at    time.Duration
}

// Tracer records when each stage of one command ended.
type Tracer struct {
	start time.Time
	marks []traceMark
	asks  int
}

// trace is the command's tracer, or nil when DEVHUB_TRACE is not 1.
var trace *Tracer

// startTrace begins timing from now, if the environment asks for it.
func startTrace(env map[string]string, start time.Time) {
	if env[TraceVariable] == "1" {
		trace = &Tracer{start: start}
	} else {
		trace = nil
	}
}

// traceAsk starts a new request's stages.
func traceAsk() {
	if trace != nil {
		trace.asks++
	}
}

// traceStage marks the end of a stage of the current request.
func traceStage(stage string) {
	if trace == nil {
		return
	}
	if trace.asks > 1 {
		stage = fmt.Sprintf("%s#%d", stage, trace.asks)
	}
	trace.marks = append(trace.marks, traceMark{stage, time.Since(trace.start)})
}

// writeTrace writes the line, ending with the exit stage.
func writeTrace(out io.Writer) {
	if trace == nil {
		return
	}
	trace.marks = append(trace.marks, traceMark{"exit", time.Since(trace.start)})
	parts := make([]string, 0, len(trace.marks))
	for _, mark := range trace.marks {
		parts = append(parts, fmt.Sprintf("%s=%.2f", mark.stage, float64(mark.at.Microseconds())/1000))
	}
	fmt.Fprintf(out, "devhub-trace: %s\n", strings.Join(parts, " "))
}
