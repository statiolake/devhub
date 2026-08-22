# Reserve Command-Q as the only Workbench prefix

In the main Workbench Window, DevHub reserves `Command+Q` as a prefix and keeps all other Workbench-oriented Command-key equivalents available to the active Surface. The first press arms a one-second prefix state. A second `Command+Q` within that interval forwards one native `Command+Q` to the active Surface. Timeout or an unmapped second key silently clears the state.

## Consequences

- The MVP defines only the `Command+Q, Command+Q` sequence and presents no indicator, toast, or sound.
- Quit remains available through the application and Dock menus without a keyboard equivalent.
- The main Window closes through its traffic-light control or a menu item without a shortcut; `Command+W` remains available to the embedded Workbench.
- `Command+,` opens DevHub Settings. `Command+M` and `Command+H` retain standard macOS behavior.
- The Settings Window uses `Command+W` to close itself.
- Native forwarding is implemented in an isolated host key router. Synthetic JavaScript events are not acceptable.
- Real OpenVSCode verification of ordinary Command shortcuts, IME, and the double-prefix forwarding path is a release gate.
