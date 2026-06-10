import { Menu, MenuItem, MenuWithRole } from "@mobrowser/api";
import { DISPLAY_NAME } from "./branding";

/**
 * Builds the macOS application menu.
 *
 * Intentionally minimal: the standard app menu (About, hide, quit), an Edit menu
 * so text in the process detail can be selected and copied, and a Window menu
 * with minimize. About sits under the app-name menu, the native macOS location,
 * rather than in the tray.
 *
 * Quit is a custom item routed through `onQuit` rather than the framework `quit`
 * role so it goes through the single application quit path that disposes the
 * services and tray; the `quit` role would call the framework quit directly and
 * skip that.
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
