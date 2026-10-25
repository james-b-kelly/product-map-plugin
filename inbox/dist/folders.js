// The folder map: which folder on this machine a project's requests run in.
// ~/.config/product-map/agent-inbox-folders.json, {"<organisation>/<project>": "/absolute/real/folder"}, and for the
// folders that track a git branch one more key, {"tracks": {"<organisation>/<project>": "origin/develop"}}. A folder
// stays a plain string so a copy of this package from before tracking (such as an installed job not yet updated)
// still reads every folder: it skips "tracks", which is not an <organisation>/<project> name, and runs untracked.
// A folder is stored as its real path (symlinks resolved), and one that is, holds or sits in a place a run must
// never see (home, /, ~/.config and this package's own config, ~/.ssh, ~/.aws, ~/.claude, ~/.gnupg, ~/.kube,
// ~/.docker, ~/.npm, ~/.local, ~/.cache, ~/Library, which runs may not read) is refused, at link time and again
// before every run.
//
// A copy of a project's repo that the inbox made and keeps (PDM-55 WU-02, copies.ts) is a tracked folder with one
// more key, {"managed": {"<organisation>/<project>": {"repo": "<name>", "url": "git@github.com:…"}}}: the repo in
// Product Map it is a copy of, so a change there is noticed. A reader from before skips it, as it skips "tracks".
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { readJson, writePrivateJson } from "./files.js";
import { checkTrack, parseTrack, trackName } from "./git.js";
import { PROJECT_PATTERN, REPO_NAME, SSH_URL } from "./mcp.js";
const TRACKS = "tracks";
const MANAGED = "managed";
export function projectArg(value) {
    const v = (value ?? "").trim();
    if (!PROJECT_PATTERN.test(v))
        throw new Error("Name the project as <organisation>/<project>, as Product Map shows it (list_projects).");
    return v;
}
/** `~` expanded against `home`, then made absolute against `cwd`. */
export function expandFolder(folder, home, cwd) {
    let f = folder.trim();
    if (f === "~")
        f = home;
    else if (f.startsWith("~/"))
        f = home + f.slice(1);
    return isAbsolute(f) ? resolve(f) : resolve(cwd, f);
}
export const isDirectory = (path) => {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
};
const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** Why a folder may not be linked, or null when it may. `folder` is a real path. */
export function unsafeFolder(folder, paths) {
    const home = real(paths.home);
    if (folder === sep)
        return "the root folder";
    // Home itself, or any folder that holds it.
    if (within(home, folder))
        return "your home folder, or a folder holding it";
    const secret = [
        [join(home, ".config"), "~/.config"],
        [real(paths.configDir), "Product Map's own settings"],
        [join(home, ".ssh"), "~/.ssh"],
        [join(home, ".aws"), "~/.aws"],
        [join(home, ".claude"), "~/.claude"],
        [join(home, ".gnupg"), "~/.gnupg"],
        [join(home, ".kube"), "~/.kube"],
        [join(home, ".docker"), "~/.docker"],
        [join(home, ".npm"), "~/.npm"],
        [join(home, ".local"), "~/.local"],
        [join(home, ".cache"), "~/.cache"],
    ];
    for (const [p, name] of secret) {
        const rp = real(p);
        if (within(folder, rp) || within(rp, folder))
            return `${name}, or a folder in or around it`;
    }
    // All of ~/Library, iCloud Drive included: a run's deny rules refuse every read there, so a folder in it would
    // be linked and never readable.
    if (within(folder, real(join(home, "Library"))))
        return LIBRARY_WHY;
    return null;
}
/** Why a folder in ~/Library is refused (`cannotLink` words it in full). */
export const LIBRARY_WHY = "inside ~/Library, which background runs cannot read";
/** The sentence refusing a folder `unsafeFolder` named a reason for. */
export function cannotLink(folder, why) {
    return why === LIBRARY_WHY
        ? `${folder} is ${LIBRARY_WHY}. Use --clone, or a folder outside ~/Library.`
        : `${folder} cannot be linked: it is ${why}.`;
}
/**
 * For a folder linked before a rule refused it: the plain sentence saying so, or null when it is still allowed (or
 * is not there). The folder is never used meanwhile (`folderFor`).
 */
export function notAllowed(l, paths) {
    if (!isDirectory(l.path))
        return null;
    const why = unsafeFolder(real(l.path), paths);
    return why ? `${l.path} is no longer allowed: it is ${why}. Link another folder with setup.` : null;
}
/**
 * The map; a file that cannot be read is treated as empty, and `onError` is told (a tick logs it). A track that is
 * not a safe name, or names no linked project, is dropped, and `onError` is told "track_invalid".
 */
export function loadFolders(paths, onError) {
    let map;
    try {
        map = readJson(paths.folders);
    }
    catch {
        onError?.("folders_unreadable");
        return {};
    }
    if (!map || typeof map !== "object" || Array.isArray(map))
        return {};
    const out = {};
    let odd = false;
    for (const [k, v] of Object.entries(map)) {
        if (!PROJECT_PATTERN.test(k))
            continue;
        if (typeof v === "string")
            out[k] = { path: v };
        // An object here ({path, track}, a shape only an unreleased build wrote) is not read: said, not silently lost.
        else if (v && typeof v === "object")
            odd = true;
    }
    if (odd)
        onError?.("track_invalid");
    const tracks = map[TRACKS];
    if (tracks !== undefined) {
        if (!tracks || typeof tracks !== "object" || Array.isArray(tracks))
            onError?.("track_invalid");
        else {
            let dropped = false;
            for (const [k, v] of Object.entries(tracks)) {
                const key = keyFor(out, k);
                let t = null;
                try {
                    t = typeof v === "string" ? trackName(parseTrack(v)) : null;
                }
                catch {
                    t = null;
                }
                if (key && t)
                    out[key].track = t;
                else
                    dropped = true;
            }
            if (dropped)
                onError?.("track_invalid");
        }
    }
    // A copy is always a tracked folder: a managed entry for a folder with no track, or not of the right shape, is dropped.
    const managed = map[MANAGED];
    if (managed !== undefined) {
        let dropped = !managed || typeof managed !== "object" || Array.isArray(managed);
        if (!dropped) {
            for (const [k, v] of Object.entries(managed)) {
                const key = keyFor(out, k);
                const m = v;
                const ok = key && out[key].track && within(real(out[key].path), real(paths.reposDir)) && m && typeof m === "object" && typeof m.repo === "string" && REPO_NAME.test(m.repo)
                    && m.repo.length <= 40 && typeof m.url === "string" && SSH_URL.test(m.url);
                if (ok)
                    out[key].managed = { repo: m.repo, url: m.url };
                else
                    dropped = true;
            }
        }
        if (dropped)
            onError?.("managed_invalid");
    }
    // A folder in the inbox's copies is never the person's own: one whose "managed" entry is missing or was dropped
    // (a bad track, or a reader from before that rewrote the file) is left out, and the next ensureCopy links it again.
    const copies = real(paths.reposDir);
    let orphan = false;
    for (const [k, l] of Object.entries(out)) {
        if (!l.managed && within(real(l.path), copies)) {
            delete out[k];
            orphan = true;
        }
    }
    if (orphan)
        onError?.("managed_invalid");
    return out;
}
function save(paths, map) {
    const sorted = sortKeys(map);
    const file = Object.fromEntries(Object.entries(sorted).map(([k, l]) => [k, l.path]));
    const tracks = Object.fromEntries(Object.entries(sorted).filter(([, l]) => l.track).map(([k, l]) => [k, l.track]));
    if (Object.keys(tracks).length)
        file[TRACKS] = tracks;
    const managed = Object.fromEntries(Object.entries(sorted).filter(([, l]) => l.managed && l.track).map(([k, l]) => [k, l.managed]));
    if (Object.keys(managed).length)
        file[MANAGED] = managed;
    writePrivateJson(paths.folders, file);
}
/** The key in the map for a project, matched without regard to case. */
const keyFor = (map, project) => Object.keys(map).find((k) => k.toLowerCase() === project.toLowerCase());
/** The real path of a folder that may be linked, or an Error saying why not. */
function linkable(paths, folder, cwd) {
    const abs = expandFolder(folder, paths.home, cwd);
    if (!isDirectory(abs))
        throw new Error(`There is no folder at ${abs}. Create it first, or pick another.`);
    const rp = realpathSync(abs);
    const why = unsafeFolder(rp, paths);
    if (why)
        throw new Error(why === LIBRARY_WHY ? cannotLink(rp, why) : `${cannotLink(rp, why)} Link the project's own folder.`);
    return rp;
}
function store(paths, key, l) {
    const map = loadFolders(paths);
    const old = keyFor(map, key);
    if (old)
        delete map[old];
    map[key] = l;
    save(paths, map);
}
/** Links a folder with no tracking (a tracked link of the project is replaced). Returns the folder's real path. */
export function link(paths, project, folder, cwd) {
    return linkPlain(paths, project, folder, cwd).path;
}
/** As `link`, and says which branch the project tracked before, if any (that tracking has now stopped). */
export function linkPlain(paths, project, folder, cwd) {
    const key = projectArg(project);
    const rp = linkable(paths, folder, cwd);
    const stopped = trackFor(loadFolders(paths), key);
    store(paths, key, { path: rp });
    return { path: rp, stopped };
}
/**
 * Links a folder that tracks `<remote>/<branch>`: the names are checked, then the folder must be a git working tree
 * and the branch must fetch and name a commit. Nothing is stored unless all of that holds.
 */
export async function linkTracked(paths, project, folder, cwd, track, git) {
    const key = projectArg(project);
    const t = parseTrack(track);
    const rp = linkable(paths, folder, cwd);
    await checkTrack(git, rp, t);
    const l = { path: rp, track: trackName(t) };
    store(paths, key, l);
    return l;
}
export function unlink(paths, project) {
    return unlinkLink(paths, project) !== null;
}
/** Unlinks a project and returns what its link was, or null when it had none. */
export function unlinkLink(paths, project) {
    const key = projectArg(project);
    const map = loadFolders(paths);
    const old = keyFor(map, key);
    if (!old)
        return null;
    const l = map[old];
    delete map[old];
    save(paths, map);
    return l;
}
/**
 * Stores a copy the inbox made (copies.ts), tracking `origin/<branch>`. The folder is not checked again here: the
 * caller just cloned it into the copies folder, and every run checks it again (`folderFor`).
 */
export function storeManaged(paths, project, l) {
    const key = projectArg(project);
    const link = { path: l.path, track: trackName(parseTrack(`origin/${l.branch}`)), managed: l.managed };
    store(paths, key, link);
    return link;
}
/** Puts back a link exactly as it was (setup, when a replacement failed part way). */
export function restoreLink(paths, project, l) {
    store(paths, projectArg(project), l);
}
/** A project's link, matched without regard to case, or null. */
export function linkFor(map, project) {
    const k = keyFor(map, project);
    return k ? map[k] : null;
}
/** The folder a project's requests run in, when it is set, still exists and is still safe to run in. */
export function folderFor(map, project, paths) {
    const k = keyFor(map, project);
    const f = k ? map[k].path : undefined;
    if (!f || !isDirectory(f))
        return null;
    const rp = real(f);
    return unsafeFolder(rp, paths) ? null : rp;
}
/** The `<remote>/<branch>` a project's folder tracks, or null. */
export function trackFor(map, project) {
    const k = keyFor(map, project);
    return (k && map[k].track) || null;
}
const sortKeys = (m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
