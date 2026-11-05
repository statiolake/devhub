/*
 * devhub-input-source: the macOS input source, switched on request.
 *
 * DevHub's chords are a prefix (Cmd+Q) followed by a plain key. With an input
 * method such as Japanese active, Chromium hands that plain key to the input
 * method before any of DevHub's code sees it, and a key the input method
 * consumes never reaches Electron's `before-input-event` at all. So when a
 * chord arms DevHub selects an ASCII-capable input source, and leaves it
 * selected. See `apps/desktop/src/main/shell/chordInputSource.ts`, which
 * decides when; this program only does what it is told, one line at a time.
 *
 * It is a process of its own because the Text Input Sources API is Carbon's
 * and Electron's main process has no way to call it. It is started once and
 * kept, so a switch costs a line on a pipe rather than a process launch.
 *
 * # The protocol
 *
 * One request per line on stdin, one reply per line on stdout, in order.
 * Fields are separated by a tab; input source IDs never contain one.
 *
 *   ascii
 *     -> unchanged <TAB> <current id>            it was ASCII-capable already
 *     -> switched <TAB> <previous id> <TAB> <selected id>
 *
 *   anything that fails
 *     -> error <TAB> <what failed>
 *
 * The request is one check-and-select, done here rather than as two round
 * trips, so nothing can change the source between the look and the act.
 *
 * # The run loop
 *
 * HIToolbox learns that another process changed the input source through a
 * notification delivered on the run loop. A program that blocked in `read`
 * would keep answering with the source it saw last, and would take a source
 * the person had switched to since for the one it saw. So stdin is read from
 * the main run loop, and the notifications are delivered between requests.
 */

#include <Carbon/Carbon.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define ID_CAPACITY 512
#define LINE_CAPACITY 4096

static char pending[LINE_CAPACITY];
static size_t pending_length = 0;

static void reply(const char *line) {
	fputs(line, stdout);
	fputc('\n', stdout);
	fflush(stdout);
}

static void reply_error(const char *what) {
	char line[LINE_CAPACITY];
	snprintf(line, sizeof line, "error\t%s", what);
	reply(line);
}

static int source_id(TISInputSourceRef source, char *out, size_t capacity) {
	CFStringRef id = TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
	if (id == NULL) return 0;
	return CFStringGetCString(id, out, (CFIndex)capacity, kCFStringEncodingUTF8) ? 1 : 0;
}

static int is_ascii_capable(TISInputSourceRef source) {
	CFBooleanRef capable = TISGetInputSourceProperty(source, kTISPropertyInputSourceIsASCIICapable);
	return capable != NULL && CFBooleanGetValue(capable);
}

static void select_ascii(void) {
	TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
	if (current == NULL) {
		reply_error("macOS reported no current keyboard input source");
		return;
	}
	char previous[ID_CAPACITY];
	if (!source_id(current, previous, sizeof previous)) {
		CFRelease(current);
		reply_error("the current keyboard input source has no ID");
		return;
	}
	char line[LINE_CAPACITY];
	if (is_ascii_capable(current)) {
		CFRelease(current);
		snprintf(line, sizeof line, "unchanged\t%s", previous);
		reply(line);
		return;
	}
	CFRelease(current);

	TISInputSourceRef ascii = TISCopyCurrentASCIICapableKeyboardInputSource();
	if (ascii == NULL) {
		reply_error("macOS reported no ASCII-capable keyboard input source");
		return;
	}
	char selected[ID_CAPACITY];
	if (!source_id(ascii, selected, sizeof selected)) {
		CFRelease(ascii);
		reply_error("the ASCII-capable keyboard input source has no ID");
		return;
	}
	OSStatus status = TISSelectInputSource(ascii);
	CFRelease(ascii);
	if (status != noErr) {
		snprintf(line, sizeof line, "TISSelectInputSource(%s) failed with OSStatus %d", selected, (int)status);
		reply_error(line);
		return;
	}
	snprintf(line, sizeof line, "switched\t%s\t%s", previous, selected);
	reply(line);
}

static void handle(char *line) {
	char *fields[3] = {line, NULL, NULL};
	int count = 1;
	for (char *tab = strchr(line, '\t'); tab != NULL; tab = strchr(tab + 1, '\t')) {
		if (count == 3) {
			reply_error("too many fields");
			return;
		}
		*tab = '\0';
		fields[count++] = tab + 1;
	}
	if (count == 1 && strcmp(fields[0], "ascii") == 0) {
		select_ascii();
	} else {
		reply_error("unknown request");
	}
}

static void readable(CFFileDescriptorRef descriptor, CFOptionFlags flags, void *info) {
	(void)flags;
	(void)info;
	ssize_t got = read(STDIN_FILENO, pending + pending_length, sizeof pending - pending_length);
	if (got == 0) exit(0); /* DevHub closed the pipe: it is going away. */
	if (got < 0) {
		if (errno == EINTR || errno == EAGAIN) {
			CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
			return;
		}
		perror("devhub-input-source: read");
		exit(1);
	}
	pending_length += (size_t)got;
	char *start = pending;
	char *newline;
	while ((newline = memchr(start, '\n', pending_length - (size_t)(start - pending))) != NULL) {
		*newline = '\0';
		handle(start);
		start = newline + 1;
	}
	size_t rest = pending_length - (size_t)(start - pending);
	if (rest == sizeof pending) {
		fputs("devhub-input-source: a request longer than the buffer\n", stderr);
		exit(1);
	}
	memmove(pending, start, rest);
	pending_length = rest;
	CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
}

int main(void) {
	CFFileDescriptorRef descriptor = CFFileDescriptorCreate(NULL, STDIN_FILENO, false, readable, NULL);
	if (descriptor == NULL) {
		fputs("devhub-input-source: cannot watch stdin\n", stderr);
		return 1;
	}
	CFRunLoopSourceRef source = CFFileDescriptorCreateRunLoopSource(NULL, descriptor, 0);
	CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopDefaultMode);
	CFFileDescriptorEnableCallBacks(descriptor, kCFFileDescriptorReadCallBack);
	CFRunLoopRun();
	return 0;
}
