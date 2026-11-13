package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"syscall"
	"time"
)

// Request is one control request: the fields of protocol.ts's ControlRequest
// that this client sends. The app validates every one.
type Request struct {
	Kind           string    `json:"kind"`
	Path           string    `json:"path,omitempty"`
	Cwd            string    `json:"cwd,omitempty"`
	Home           string    `json:"home,omitempty"`
	Machine        string    `json:"machine,omitempty"`
	Origin         string    `json:"origin,omitempty"`
	Position       *Position `json:"position,omitempty"`
	WaitMarkerPath string    `json:"waitMarkerPath,omitempty"`
	ProfileID      string    `json:"profileId,omitempty"`
	// add-agent: always sent, empty included; the app requires the array.
	Args  *[]string `json:"args,omitempty"`
	Argv  []string  `json:"argv,omitempty"`
	Stdin *string   `json:"stdin,omitempty"`
	// tell only: the files the app asked for (an answer's `files`), read
	// on this machine, each by the absolute path it named, base64.
	Files map[string]string `json:"files,omitempty"`
}

// Response is protocol.ts's ControlResponse.
type Response struct {
	OK      bool            `json:"ok"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
	// tell only: --json was given; the refusal is one of the command line
	// (exit 2); a `-` in the words is text, so send what is piped in.
	JSON  bool `json:"json,omitempty"`
	Usage bool `json:"usage,omitempty"`
	Stdin bool `json:"stdin,omitempty"`
	// tell only: the words name files (`--attach`) to be read here, where
	// the command runs, and sent with the request again.
	Files []string `json:"files,omitempty"`
}

// ErrNotRunning is a socket with nobody behind it.
var ErrNotRunning = errors.New("DevHub is not running.")

// encodeLine is JSON.stringify's spelling: no HTML escaping, one line.
func encodeLine(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// Ask sends one request on a connection of its own and reads the one line
// that answers it.
func Ask(socketPath string, request Request) (Response, error) {
	session, err := Dial(socketPath)
	if err != nil {
		return Response{}, err
	}
	defer session.Close()
	return session.Ask(request)
}

// Session is one connection to the control socket. The app answers a request
// and closes, except when the answer asks for what only the command can read
// (`--tell`'s piped text or attached files): then it keeps the connection
// open for the request again, so the second asking costs no new connection —
// over a host's forwarded socket, a new channel on the ssh connection and so
// a network round trip (docs/devhub-cli.md, "Protocol").
type Session struct {
	socketPath string
	connection net.Conn
	reader     *bufio.Reader
}

// Dial connects to the control socket.
func Dial(socketPath string) (*Session, error) {
	traceAsk()
	connection, err := net.Dial("unix", socketPath)
	traceStage("connected")
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
			return nil, ErrNotRunning
		}
		return nil, err
	}
	return &Session{socketPath: socketPath, connection: connection}, nil
}

// Close lets the connection go.
func (s *Session) Close() {
	if s.connection != nil {
		s.connection.Close()
		s.connection = nil
	}
}

// Ask sends one request on this connection and reads the line that answers
// it.
func (s *Session) Ask(request Request) (Response, error) {
	line, err := encodeLine(request)
	if err != nil {
		return Response{}, err
	}
	if _, err := s.connection.Write(line); err != nil {
		return Response{}, err
	}
	traceStage("written")
	if s.reader == nil {
		s.reader = bufio.NewReaderSize(s.connection, 1<<16)
	}
	answer, err := s.reader.ReadBytes('\n')
	traceStage("answered")
	if len(bytes.TrimRight(answer, "\n")) == 0 {
		if err != nil && !errors.Is(err, net.ErrClosed) && err.Error() != "EOF" {
			return Response{}, err
		}
		return Response{}, errors.New("DevHub closed the connection without answering.")
	}
	var response Response
	if err := json.Unmarshal(answer, &response); err != nil {
		return Response{}, fmt.Errorf("DevHub answered something that is not a response: %w", err)
	}
	return response, nil
}

// AskAgain sends a request once more after an answer that asked for
// something, on this connection, which the app kept open for it. Never on a
// new one if this one failed: the app may have read the request and acted on
// it before the answer was lost, and `agent send` twice is two messages.
func (s *Session) AskAgain(request Request) (Response, error) {
	if s.connection == nil {
		return Response{}, errors.New("DevHub closed the connection without answering.")
	}
	traceAsk()
	return s.Ask(request)
}

// LivenessTimeout bounds a ping: an app that cannot answer one in this long
// is treated as not there.
const LivenessTimeout = 2 * time.Second

// SocketAnswers is whether a DevHub answers a ping on the socket. A
// connection alone proves nothing: a socket reverse-forwarded with ssh -R
// belongs to the host's sshd, which accepts long after DevHub has quit.
func SocketAnswers(socketPath string, timeout time.Duration) bool {
	connection, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return false
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(timeout))
	if _, err := connection.Write([]byte("{\"kind\":\"ping\"}\n")); err != nil {
		return false
	}
	_, err = bufio.NewReader(connection).ReadString('\n')
	return err == nil
}
