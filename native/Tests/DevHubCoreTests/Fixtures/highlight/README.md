# Highlight fixtures

`samples.json`: a code sample per grammar the transcript colours.
`expected.json`: what the TS app's `highlight()` (Shiki 4.4.3, its JavaScript
regex engine, Light+ and Dark+) makes of each: per line, per token,
`[text, light, dark]`, a colour `null` where it is the theme's own
foreground. Produced once, outside `native/`, by running Shiki over the
samples; nothing in `native/` runs JavaScript.
