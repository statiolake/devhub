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

// Ask sends one request and reads the one line that answers it.
func Ask(socketPath string, request Request) (Response, error) {
	connection, err := net.Dial("unix", socketPath)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) {
			return Response{}, ErrNotRunning
		}
		return Response{}, err
	}
	defer connection.Close()
	line, err := encodeLine(request)
	if err != nil {
		return Response{}, err
	}
	if _, err := connection.Write(line); err != nil {
		return Response{}, err
	}
	reader := bufio.NewReaderSize(connection, 1<<16)
	answer, err := reader.ReadBytes('\n')
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
