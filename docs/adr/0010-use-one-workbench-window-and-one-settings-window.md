# Use one Workbench Window and one Settings Window

The MVP permits exactly one main Workbench Window. A singleton Settings Window is the only auxiliary Window and never owns a Workspace, Activity, Editor, Agent, or terminal Surface.

The main Window uses a native macOS titlebar and traffic lights. Editor, Agent, and Terminal Activities are integrated into the titlebar toolbar. Navigation selection in the Sidebar is the only context label; DevHub adds neither a subtitle strip nor a bottom status bar.

## Consequences

- Reopening DevHub focuses or reconstructs the one main Workbench Window rather than creating another.
- Settings opens from the application menu or `Command+,`; a second invocation focuses the existing Settings Window.
- Settings sections are General, Workspaces, Agents, Runtimes, and Appearance.
- The DevHub shell follows the system appearance. The embedded Workbench and xterm keep their own theme settings.
- The visual language is a quiet, dense macOS professional tool: restrained materials, no browser-style tabs, no decorative cards, and no redundant chrome around editor and terminal Surfaces.
- Agent states combine symbol, text or accessible label, and color rather than relying on color alone.
