import { Menu, MenuItem, MenuWithRole } from "@mobrowser/api";
import { DISPLAY_NAME } from "./branding";

/**
 * Builds the minimal macOS application menu: the standard app menu, an Edit
 * menu so detail text can be selected and copied, and a Window menu. Quit is a
 * custom item routed through `onQuit` (not the framework `quit` role) so it
 * goes through the single quit path that disposes the services and tray.
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
