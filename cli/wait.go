package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

// WaitPoll is how often --wait looks at its marker: a stat, here.
const WaitPoll = 250 * time.Millisecond

// WaitPingEvery is how many marker looks there are to one ping. A ping is a
// connection to DevHub — on a host, a channel opened on the ssh connection
// and a round trip — so it is asked every two seconds, not with every look:
// a closed editor is still seen within WaitPoll, and a DevHub that went away
// within two seconds plus a ping.
const WaitPingEvery = 8

func randomHex(bytes int) string {
	buffer := make([]byte, bytes)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// CreateMarker makes the file a --wait holds the terminal open for: the
// app deletes it once the editor is closed. It exists before the request
// that names it, so "not there" can only mean "closed".
func CreateMarker(temporaryDirectory string) (string, error) {
	directory := filepath.Join(temporaryDirectory, "devhub-wait-"+randomHex(6))
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	marker := filepath.Join(directory, "marker")
	file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	return marker, file.Close()
}

// RemoveMarker removes the marker's directory, however the wait ended.
func RemoveMarker(marker string) { _ = os.RemoveAll(filepath.Dir(marker)) }

// WaitWorld is what WaitForClose looks at, so tests can drive it.
type WaitWorld struct {
	MarkerExists  func() bool
	DevhubAnswers func() bool
	SocketPath    string
	Pause         func(time.Duration)
}

// MarkerWorld is the real one.
func MarkerWorld(marker, socketPath string) WaitWorld {
	return WaitWorld{
		MarkerExists: func() bool {
			_, err := os.Stat(marker)
			return err == nil
		},
		DevhubAnswers: func() bool { return SocketAnswers(socketPath, LivenessTimeout) },
		SocketPath:    socketPath,
		Pause:         time.Sleep,
	}
}

// WaitForClose returns once the marker is gone, and fails if DevHub stops
// answering first: nobody is left to close the file.
func WaitForClose(world WaitWorld) error {
	for look := 0; ; look++ {
		if !world.MarkerExists() {
			return nil
		}
		if look%WaitPingEvery == 0 && !world.DevhubAnswers() {
			return fmt.Errorf("DevHub is not listening on %s: it stopped while the file was still open, so the file was never closed and nothing was saved by closing it.", world.SocketPath)
		}
		world.Pause(WaitPoll)
	}
}

// SpoolStdin copies what is piped in to a new 0600 file for `devhub -`.
func SpoolStdin(source io.Reader, temporaryDirectory string) (string, error) {
	path := filepath.Join(temporaryDirectory, "devhub-stdin-"+randomHex(6))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(file, source); err != nil {
		file.Close()
		return "", err
	}
	return path, file.Close()
}
