# Appearance and themes

On web and desktop, open **Settings → Appearance** to choose a theme and follow the system
appearance or stay in light or dark mode. To use different themes for light and dark mode, select
the corresponding preview within each theme. Appearance preferences are saved separately on each
device or browser.

On web and desktop, use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

On mobile, open **Settings → Appearance**. Mobile has its own themes and text,
code, and terminal preferences. It does not follow environment themes or defaults.

On Android 12 or newer, choose the **Material You** theme in Appearance to use colors from
your wallpaper. Selecting another theme replaces those colors. Like other themes, Material You
can be selected separately for light and dark appearances.
Android uses **Material You Layout** by default unless you have turned it off in Appearance.
It changes shapes, spacing, and controls independently
of the selected theme.

## Thread glyphs

Web and desktop threads have a colored outline glyph for quick recognition. Click the glyph beside
the conversation header, or choose **Reroll glyph** from the thread menu, to pick another. The glyph
stays the same when you rename the thread or reopen it on another connected client. While an agent
works, two contrasting embers follow a tilted orbit around the glyph.

## Tiled workspace

On wider web and desktop windows, each thread remembers its own tiles and tab groups. Use a tile's
**Add area** menu for a browser, terminal, files, Notes, or Workspace. Drag a tab into another
tile’s tab bar to group it, or to an edge to split it. A tile too narrow to split side by side
doesn't take drops on its left and right edges. Drag the empty title bar to move a whole tile
group; drop on a tab bar to join groups, in the center to swap them, or at an edge to dock.
New tiles start with a New tab showing an area chooser. Middle-click an area tab to close it. Each group keeps its color.
**Main chat**, the thread's conversation, can move between tiles too. It opens in one tile at a
time, so choosing it from another tile's chooser takes you to the tile that has it.

Use **Ctrl+Alt+arrows** or **Ctrl+Alt+H/J/K/L** to focus a neighboring tile, add **Shift** to split the selected tab, and use
**Ctrl+Alt+Enter** to maximize or restore a tile. **Ctrl+Tab** and **Ctrl+Shift+Tab** cycle tabs
within the focused tile on Windows, Linux, and macOS.
Hold **Ctrl+Alt+R** and move the mouse to resize the focused tile from the pointer’s starting
position. Release to keep the size or press **Esc** to cancel. Arrow keys also adjust the size
while holding the resize shortcut.
Use **Ctrl+Alt+F** to focus the selected tab on the right, then choose a tab for the left.
The two tabs can come from the same group. Toggle Focus again to restore all tiles. The shared divider can be resized, and
maximize remains separate.
These commands can be changed in **Settings → Keybindings**. On narrow windows, areas use the
compact panel presentation while the wider layout stays saved.

## Math

Turn on **Render math** in **Settings → Appearance** to typeset LaTeX in messages and Markdown
previews on web, desktop, and mobile. It reads `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`, outside of code.
Fenced `math` blocks also render. Formulas work in tables, including absolute-value bars.
Dollar amounts such as `$5 and $10` stay text; write `\$` to keep any other dollar sign literal.
Wide formulas scroll horizontally while the surrounding text wraps. Copying a formula or
exporting a table preserves the TeX.

The composer keeps TeX source editable, including when rich text is enabled. The Render math
preference is saved separately on each device.

## Motion

The main sidebar opens and closes immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Weavewing or VS Code
theme. The theme editor's color picker lets you select an area of the app to find the color to
change. Export your theme as JSON to share it.

### Custom CSS

For a change that colors cannot make, open **Custom CSS** in the theme editor. The CSS is saved with
the theme, applies after Weavewing's own styles on web and desktop, and is included in exports. Use
`.dark` or `:root:not(.dark)` to target one appearance.

Custom CSS cannot load files. `@import`, `image-set()`, and `url()` are ignored, except `url()`
with a `data:` address or an `#id`. This keeps an imported theme from sending what is on your screen
to another site.

Class names in the app change between releases. For rules that keep working, target `data-slot`
and other `data-` attributes, such as `[data-chat-header]` or `[data-slot="button"]`.

If a rule hides something you need, run `t3 theme set t3-chat` on the server to switch to a
built-in theme, or press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to pick
another theme.

### Ask an agent

An agent on the same machine as the server can restyle Weavewing for you. Ask it to change the look,
for example "make Weavewing's chat header taller" or "give Weavewing a solarized theme". It publishes
an [environment theme](#environment-themes) with colors and CSS, and web and desktop clients of that
server switch to it. It can also switch them to light, dark, or system mode. The thread must run
in Full access. Ask the agent to set a built-in theme to undo it.

## Environment themes

Environment themes and defaults come from the server serving your web app or the desktop app's
main local environment. With the desktop app's local environment off, they come from the
[background service](./background-service.md) on the same machine while the app is connected to
it. Upstream T3 Code's hosted web app (app.t3.codes) and other connections do not use them.

Select a published theme in **Settings → Appearance** to follow its palette as the server updates
it. **Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID
takes precedence. If the server stops publishing the selected theme, Weavewing falls back to its
standard theme.

Run this on the server to set a default and switch connected clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes.

### Publish a theme

Save a theme exported from Weavewing into `~/.t3/userdata/themes/` on the server, or the `themes`
directory under your custom state directory. The filename supplies the theme ID: `nightfall.json`
can be selected with `t3 theme set nightfall`. Keep the filename stable when updating its colors.
Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. Weavewing
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view. An optional `css` string adds [custom CSS](#custom-css).

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published.
