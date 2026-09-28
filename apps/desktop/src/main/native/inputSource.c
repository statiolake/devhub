/*
 * devhub-input-source: the macOS input source, switched on request.
 *
 * DevHub's chords are a prefix (Cmd+Q) followed by a plain key. With an input
 * method such as Japanese active, Chromium hands that plain key to the input
 * method before any of DevHub's code sees it, and a key the input method
 * consumes never reaches Electron's `before-input-event` at all. So while a
 * chord is armed DevHub selects an ASCII-capable input source, and selects the
 * previous one again when the chord is over. See
 * `apps/desktop/src/main/shell/chordInputSource.ts`, which decides when; this
 * program only does what it is told, one line at a time.
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
 *   restore <TAB> <previous id> <TAB> <selected id>
 *     -> restored                                 <selected> was still current
 *     -> kept <TAB> <current id>                  somebody chose another since
 *
 *   anything that fails
 *     -> error <TAB> <what failed>
 *
 * Both requests are one check-and-select each, done here rather than as two
 * round trips, so nothing can change the source between the look and the act.
 *
 * # The run loop
 *
 * HIToolbox learns that another process changed the input source through a
 * notification delivered on the run loop. A program that blocked in `read`
 * would keep answering with the source it saw last, and would then "restore"
 * over a choice the person had made in the meantime. So stdin is read from the
 * main run loop, and the notifications are delivered between requests.
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

/* The enabled keyboard input source with this ID, retained, or NULL. */
static TISInputSourceRef source_named(const char *wanted) {
	CFStringRef id = CFStringCreateWithCString(NULL, wanted, kCFStringEncodingUTF8);
	if (id == NULL) return NULL;
	const void *keys[] = {kTISPropertyInputSourceID};
	const void *values[] = {id};
	CFDictionaryRef filter = CFDictionaryCreate(
		NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFRelease(id);
	CFArrayRef found = TISCreateInputSourceList(filter, false);
	CFRelease(filter);
	if (found == NULL) return NULL;
	TISInputSourceRef source = NULL;
	if (CFArrayGetCount(found) > 0) {
		source = (TISInputSourceRef)CFRetain(CFArrayGetValueAtIndex(found, 0));
	}
	CFRelease(found);
	return source;
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

static void restore(const char *previous, const char *selected) {
	TISInputSourceRef current = TISCopyCurrentKeyboardInputSource();
	if (current == NULL) {
		reply_error("macOS reported no current keyboard input source");
		return;
	}
	char now[ID_CAPACITY];
	int named = source_id(current, now, sizeof now);
	CFRelease(current);
	if (!named) {
		reply_error("the current keyboard input source has no ID");
		return;
	}
	char line[LINE_CAPACITY];
	if (strcmp(now, selected) != 0) {
		snprintf(line, sizeof line, "kept\t%s", now);
		reply(line);
		return;
	}
	TISInputSourceRef source = source_named(previous);
	if (source == NULL) {
		snprintf(line, sizeof line, "no enabled keyboard input source is named %s", previous);
		reply_error(line);
		return;
	}
	OSStatus status = TISSelectInputSource(source);
	CFRelease(source);
	if (status != noErr) {
		snprintf(line, sizeof line, "TISSelectInputSource(%s) failed with OSStatus %d", previous, (int)status);
		reply_error(line);
		return;
	}
	reply("restored");
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
	} else if (count == 3 && strcmp(fields[0], "restore") == 0) {
		restore(fields[1], fields[2]);
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
