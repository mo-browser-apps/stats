import { Menu, MenuItem, MenuWithRole } from "@mobrowser/api";

/** Human-facing app name (macron-branded), per the MoBrowser apps branding guide. */
const DISPLAY_NAME = "MōStats";

/**
 * Builds the macOS application menu.
 *
 * MoStats is a compact fixed-size utility, so the menu is intentionally minimal:
 * the standard app menu (with About, hide, and quit), an Edit menu so text in the
 * process detail can be selected and copied, and a Window menu with minimize.
 * There is no File, View/zoom, or Help menu because the app has no documents, a
 * fixed layout, and no in-app help. About is here (the native macOS location,
 * under the app-name menu at the left of the menu bar) rather than in the tray.
 *
 * Quit is a custom item routed through `onQuit` rather than the framework `quit`
 * role: like the tray Quit, it must go through the single application quit path
 * so the metrics/process services and tray are disposed before the process exits
 * (the `quit` role would call the framework quit directly and skip that).
 *
 * @param onAbout Invoked when the user selects About; the owner shows the dialog.
 * @param onQuit Invoked when the user selects Quit; the owner disposes services
 *   and then quits the app.
 */
export function buildApplicationMenu(onAbout: () => void, onQuit: () => void): Menu {
  const appMenu = new MenuWithRole({
    role: "macAppMenu",
    items: [
      new MenuItem({
        id: "about",
        label: `About ${DISPLAY_NAME}`,
        action: () => onAbout(),
      }),
      "separator",
      "macHideApp",
      "macHideOthers",
      "macShowAll",
      "separator",
      new MenuItem({
        id: "quit",
        label: `Quit ${DISPLAY_NAME}`,
        shortcut: "CommandOrControl+Q",
        action: () => onQuit(),
      }),
    ],
  });

  const editMenu = new MenuWithRole({
    role: "editMenu",
    items: [
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ],
  });

  const windowMenu = new MenuWithRole({
    role: "windowMenu",
    items: ["minimizeWindow"],
  });

  return new Menu({ items: [appMenu, editMenu, windowMenu] });
}
