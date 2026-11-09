package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const (
	LaunchCommandVariable = "DEVHUB_LAUNCH_COMMAND"
	InstallCommandHint    = "\"DevHub: Install 'devhub' command in PATH\" from DevHub's command palette (Cmd+Q :)"
	LaunchTimeout         = 30 * time.Second
	LaunchPoll            = 200 * time.Millisecond
)

// Launcher is what to do when nothing answers: start DevHub (this Mac) or
// say why it cannot be started from here (a host).
type Launcher struct {
	SocketPath  string
	Description string
	CannotStart func(reason string) string
	Open        func() error // returns once started, or with why not
	Answers     func() bool
	Pause       func(time.Duration)
	Now         func() time.Time
}

// ParseLaunchCommand reads DEVHUB_LAUNCH_COMMAND, a JSON array of strings.
func ParseLaunchCommand(raw string) ([]string, error) {
	if raw == "" {
		return nil, fmt.Errorf("%s is not set, so this launcher does not know how to start DevHub. Run %s to write it again.", LaunchCommandVariable, InstallCommandHint)
	}
	var command []string
	if err := json.Unmarshal([]byte(raw), &command); err != nil || len(command) == 0 {
		return nil, fmt.Errorf("%s is not a command: %s", LaunchCommandVariable, raw)
	}
	return command, nil
}

func systemLauncher(socketPath string) Launcher {
	return Launcher{
		SocketPath: socketPath,
		Answers:    func() bool { return SocketAnswers(socketPath, LivenessTimeout) },
		Pause:      time.Sleep,
		Now:        time.Now,
	}
}

// CommandLauncher starts DevHub with the launch command, detached.
func CommandLauncher(socketPath string, command []string, env []string) Launcher {
	launcher := systemLauncher(socketPath)
	joined := strings.Join(command, " ")
	launcher.Description = joined
	launcher.CannotStart = func(reason string) string {
		return fmt.Sprintf("DevHub is not running, and it could not be started: %s\nThe 'devhub' launcher starts DevHub with %s. If DevHub has moved, run %s again.", reason, joined, InstallCommandHint)
	}
	launcher.Open = func() error { return runDetached(command, env) }
	return launcher
}

// ForwardedSocketLauncher is a host's: DevHub runs where the window is.
func ForwardedSocketLauncher(socketPath, machine string) Launcher {
	nothing := fmt.Sprintf("DevHub is not listening on %s.", socketPath)
	launcher := systemLauncher(socketPath)
	launcher.Description = "nothing — DevHub does not run on " + machine
	launcher.CannotStart = func(string) string {
		return fmt.Sprintf("%s\nDevHub runs on the machine this window belongs to, and reaches %s over a socket forwarded onto it, so it cannot be started from here. Check that DevHub is running and that the window for %s is still open.", nothing, machine, machine)
	}
	launcher.Open = func() error { return errors.New(nothing) }
	return launcher
}

// runDetached starts the command in a session of its own and returns once
// it has started — or, if it exits non-zero first, with that.
func runDetached(command []string, env []string) error {
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = withoutVariable(env, "ELECTRON_RUN_AS_NODE")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			return fmt.Errorf("%s exited with status %d", command[0], exit.ExitCode())
		}
		return nil
	case <-time.After(LaunchTimeout):
		return nil
	}
}

func withoutVariable(env []string, name string) []string {
	out := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, name+"=") {
			out = append(out, entry)
		}
	}
	return out
}

// SendOrLaunch sends; if nobody is there, starts DevHub, waits for its
// socket to answer, and sends again.
func SendOrLaunch(send func() (Response, error), launcher Launcher) (Response, error) {
	response, err := send()
	if !errors.Is(err, ErrNotRunning) {
		return response, err
	}
	if err := LaunchAndWait(launcher); err != nil {
		return Response{}, err
	}
	return send()
}

// LaunchAndWait starts DevHub and waits for the socket, whichever ends
// first: a start that failed, or an answer.
func LaunchAndWait(launcher Launcher) error {
	failed := make(chan error, 1)
	go func() {
		if err := launcher.Open(); err != nil {
			failed <- errors.New(launcher.CannotStart(err.Error()))
		}
	}()
	deadline := launcher.Now().Add(LaunchTimeout)
	for {
		select {
		case err := <-failed:
			return err
		default:
		}
		if launcher.Answers() {
			return nil
		}
		if !launcher.Now().Before(deadline) {
			return fmt.Errorf("DevHub was started with %s, but nothing was listening on %s within %d seconds.", launcher.Description, launcher.SocketPath, int(LaunchTimeout/time.Second))
		}
		launcher.Pause(LaunchPoll)
	}
}

func osEnvironment() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if name, value, ok := strings.Cut(entry, "="); ok {
			env[name] = value
		}
	}
	return env
}
