// This Mac's own choices for the inbox: whether runs may use the web (`web on`). Off unless the person turns it on.
import { readJson, writePrivateJson } from "./files.js";
/** The settings; a file that cannot be read is the defaults (web off). */
export function loadSettings(paths) {
    try {
        const s = readJson(paths.settings);
        return { web: s?.web === true };
    }
    catch {
        return { web: false };
    }
}
export function saveSettings(paths, s) {
    writePrivateJson(paths.settings, { web: s.web === true });
}
