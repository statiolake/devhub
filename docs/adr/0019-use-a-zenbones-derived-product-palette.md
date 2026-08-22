# Use a Zenbones-derived product palette

DevHub uses a restrained fixed-light palette derived from the approved navigation prototype and the user's Zenbones terminal environment. Stone canvas and chrome colors support a charcoal text hierarchy, a narrow blue accent, and accessible semantic Agent states.

The App Icon represents Editor, Agent, and Terminal as three simple panes converging into one hub. It uses the same stone, charcoal, and blue vocabulary without letters, code glyphs, terminal prompts, robots, or third-party marks.

## Consequences

- Product tokens are canvas `#f3f1ef`, chrome `#e9e5e2`, surface `#fbfaf9`, text `#2c363c`, secondary `#6f6864`, selection `#cbd9e3`, accent `#286486`, working `#4f6c31`, waiting `#9a6700`, and error `#a8334c`.
- Accent and semantic colors occupy small functional areas rather than decorative backgrounds.
- OpenVSCode and xterm content themes remain runtime-owned.
- The icon has one vector master, remains legible at 16 px, and generates the complete macOS iconset and ICNS bundle asset.
- Wordmarks, animation, and marketing graphics are outside the MVP.
