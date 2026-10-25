// The background job: a launchd agent that runs `poll` every 60 seconds. macOS only for now.
// `install` copies the built code to ~/.config/product-map/agent-inbox-app (npx's cache can be cleared at any time),
// writes ~/Library/LaunchAgents/com.productmap.agent-inbox.plist and loads it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { ensurePrivateDir } from "./files.js";
import { LABEL, PACKAGE_ROOT } from "./paths.js";
import { findClaude } from "./run.js";
export const MACOS_ONLY = "The background job is macOS only for now. You can run `npx product-map-inbox poll` from your own scheduler.";
const TEMPLATE = join(PACKAGE_ROOT, "plist", `${LABEL}.plist.template`);
export const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
export function renderPlist(v, template = readFileSync(TEMPLATE, "utf8")) {
    const values = { LABEL, NODE: v.node, SCRIPT: v.script, PATH: v.path, HOME: v.home, LOG: v.log };
    return template.replace(/\{\{([A-Z]+)\}\}/g, (_m, key) => {
        if (!(key in values))
            throw new Error(`The plist template names an unknown value: ${key}`);
        return xmlEscape(values[key]);
    });
}
/** The job's PATH: where claude and node were found at install time, then the system folders. */
const colonMessage = (d) => `${d} has a ":" in its name, so it cannot be on the job's PATH. Install Claude Code and Node in folders without one, then run setup again.`;
export function jobPath(claude, node) {
    // A folder with ":" in its name would split into two PATH entries, the second of which nobody chose.
    for (const d of [dirname(claude), dirname(node)]) {
        if (d.includes(":"))
            throw new Error(colonMessage(d));
    }
    const dirs = [dirname(claude), dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    return [...new Set(dirs)].join(":");
}
export const realLaunchctl = (args) => {
    try {
        execFileSync("launchctl", args, { stdio: "ignore" });
        return { ok: true };
    }
    catch {
        return { ok: false };
    }
};
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const domain = (uid) => `gui/${uid}`;
export const NO_CLAUDE = "Claude Code (`claude`) was not found (in ~/.claude/local, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin or your PATH). Install it, then run this again.";
/** The plist `install` would write now, and the `claude` it would run. Throws NO_CLAUDE when there is none. */
export function expectedPlist(paths, deps) {
    const found = findClaude(deps.env.PATH, paths.home, deps.claudeDirs);
    if (!found)
        throw new Error(NO_CLAUDE);
    const node = deps.node ?? process.execPath;
    return { xml: renderPlist({ node, script: join(paths.appDir, "dist", "cli.js"), path: jobPath(found.found, node), home: paths.home, log: paths.log }), claude: found };
}
/** Why the job's PATH cannot be written (a folder of `claude` or Node with ":" in its name), or null. */
export function jobPathProblem(paths, deps) {
    const found = findClaude(deps.env.PATH, paths.home, deps.claudeDirs);
    const node = deps.node ?? process.execPath;
    for (const d of [found ? dirname(found.found) : "", dirname(node)])
        if (d.includes(":"))
            return colonMessage(d);
    return null;
}
/** A digest of a file, or of every file under a folder (paths and contents); "" when it is missing. */
function treeDigest(dir) {
    const h = createHash("sha256");
    const walk = (d) => {
        let names;
        try {
            names = readdirSync(d).sort();
        }
        catch {
            return;
        }
        for (const n of names) {
            const p = join(d, n);
            const st = lstatSync(p);
            if (st.isDirectory())
                walk(p);
            else if (st.isFile())
                h.update(`${relative(dir, p)}\0`).update(readFileSync(p)).update("\0");
        }
    };
    let top;
    try {
        top = lstatSync(dir);
    }
    catch {
        return "";
    }
    if (top.isFile())
        return h.update(readFileSync(dir)).digest("hex");
    walk(dir);
    return h.digest("hex");
}
const COPIED = ["dist", "package.json", "plist", "skill"];
/** Whether the job's copy of the code is this package's (the files `install` copies are the same). */
function sameCode(root, appDir) {
    if (resolve(root) === resolve(appDir))
        return true;
    return COPIED.every((name) => treeDigest(join(root, name)) === treeDigest(join(appDir, name)));
}
export function checkJob(paths, deps) {
    if ((deps.platform ?? process.platform) !== "darwin")
        return { supported: false, installed: false, loaded: false, current: false, problem: null };
    const s = jobState(paths, deps);
    const base = { supported: true, installed: s.installed, loaded: s.loaded, current: false };
    if (jobPathProblem(paths, deps))
        return { ...base, problem: "path_has_colon" };
    if (!s.installed)
        return { ...base, problem: "not_installed" };
    let want;
    try {
        want = expectedPlist(paths, deps).xml;
    }
    catch (err) {
        return { ...base, problem: err instanceof Error && err.message === NO_CLAUDE ? "no_claude" : "old_job" };
    }
    let have = "";
    try {
        have = readFileSync(paths.plist, "utf8");
    }
    catch { /* differs */ }
    if (have !== want)
        return { ...base, problem: "old_job" };
    if (!sameCode(deps.packageRoot ?? PACKAGE_ROOT, paths.appDir))
        return { ...base, problem: "old_code" };
    if (!s.loaded)
        return { ...base, problem: "not_loaded" };
    return { ...base, current: true, problem: null };
}
/** The version in a package.json, or null. */
function packageVersion(dir) {
    try {
        const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
        return typeof v === "string" ? v : null;
    }
    catch {
        return null;
    }
}
/** A `.new-*` this old is a copy no install is still making (a copy takes seconds). */
const STALE_NEW_MS = 10 * 60_000;
/** The time in a copy's tag, `<pid>-<ms>`, or null. */
const tagTime = (name) => {
    const m = /-(\d+)-(\d+)$/.exec(name);
    return m ? Number(m[2]) : null;
};
/**
 * What an interrupted copy left beside `appDir`. A `.new-*` older than ten minutes (by the time in its tag) is removed:
 * a newer one may be another install's copy in progress. When `appDir` itself is missing (a swap stopped between its
 * two renames), the `.old-*` with the latest tag that holds `dist/cli.js` is put back as `appDir`; the other `.old-*`
 * are removed.
 */
export function sweepAppDir(appDir, now = Date.now()) {
    const parent = dirname(appDir);
    const base = basename(appDir);
    let names;
    try {
        names = readdirSync(parent);
    }
    catch {
        return;
    }
    for (const n of names.filter((x) => x.startsWith(`${base}.new-`))) {
        const at = tagTime(n);
        if (at === null || now - at > STALE_NEW_MS)
            rmSync(join(parent, n), { recursive: true, force: true });
    }
    const olds = names.filter((x) => x.startsWith(`${base}.old-`))
        .map((n) => ({ n, at: tagTime(n) ?? 0 }))
        .sort((x, y) => y.at - x.at);
    if (!existsSync(appDir)) {
        const back = olds.find((o) => existsSync(join(parent, o.n, "dist", "cli.js")));
        if (back) {
            renameSync(join(parent, back.n), appDir);
            olds.splice(olds.indexOf(back), 1);
        }
    }
    for (const o of olds)
        rmSync(join(parent, o.n), { recursive: true, force: true });
}
/**
 * Puts this package's code in the job's own folder, `appDir`, replacing an older copy as one step: it is copied to a
 * folder beside it first, then swapped in by rename, so the job never runs half a copy. The job always runs this
 * folder, never the package it was installed from (npx's cache, or the plugin's per-version cache, can go at any time).
 */
function copyCode(root, appDir) {
    const tag = `${process.pid}-${Date.now()}`;
    const fresh = `${appDir}.new-${tag}`;
    const old = `${appDir}.old-${tag}`;
    rmSync(fresh, { recursive: true, force: true });
    mkdirSync(fresh, { recursive: true, mode: 0o700 });
    try {
        cpSync(join(root, "dist"), join(fresh, "dist"), { recursive: true });
        cpSync(join(root, "package.json"), join(fresh, "package.json"));
        cpSync(join(root, "plist"), join(fresh, "plist"), { recursive: true });
        if (existsSync(join(root, "skill")))
            cpSync(join(root, "skill"), join(fresh, "skill"), { recursive: true });
    }
    catch (err) {
        rmSync(fresh, { recursive: true, force: true });
        throw err;
    }
    const had = existsSync(appDir);
    if (had)
        renameSync(appDir, old);
    try {
        renameSync(fresh, appDir);
    }
    catch (err) {
        if (had)
            renameSync(old, appDir);
        rmSync(fresh, { recursive: true, force: true });
        throw err;
    }
    // The new copy is in place: an old one that cannot be removed now is swept by the next install.
    try {
        rmSync(old, { recursive: true, force: true });
    }
    catch (err) {
        console.error(`The inbox's previous copy at ${old} could not be removed (${err instanceof Error ? err.message : "unknown"}); the next setup removes it.`);
    }
}
export function install(paths, deps) {
    if ((deps.platform ?? process.platform) !== "darwin")
        throw new Error(MACOS_ONLY);
    const { xml: plist, claude: found } = expectedPlist(paths, deps);
    const claude = found.real;
    const root = deps.packageRoot ?? PACKAGE_ROOT;
    if (!existsSync(join(root, "dist", "cli.js")))
        throw new Error("The built code is missing (dist/cli.js). Run this from the published package.");
    // Copy the code, replacing an older copy, unless it is this package's already. No dependencies, so dist/ and
    // package.json are the whole program. Run from that copy itself (the job's own cli.js), there is nothing to copy.
    ensurePrivateDir(paths.configDir);
    sweepAppDir(paths.appDir);
    let copied = null;
    if (resolve(root) !== resolve(paths.appDir) && !sameCode(root, paths.appDir)) {
        const replaced = existsSync(paths.appDir);
        const from = replaced ? packageVersion(paths.appDir) : null;
        copyCode(root, paths.appDir);
        copied = { replaced, from, to: packageVersion(paths.appDir) };
    }
    mkdirSync(paths.launchAgents, { recursive: true });
    mkdirSync(dirname(paths.log), { recursive: true });
    writeFileSync(paths.plist, plist, { mode: 0o644 });
    const launchctl = deps.launchctl ?? realLaunchctl;
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    const sleep = deps.sleep ?? sleepSync;
    // bootout returns before launchd has let go of the label, and a bootstrap then fails: wait until it is gone.
    launchctl(["bootout", domain(uid), paths.plist]);
    for (let i = 0; i < 25 && launchctl(["print", `${domain(uid)}/${LABEL}`]).ok; i++)
        sleep(200);
    let loaded = false;
    for (let i = 0; i < 3 && !loaded; i++) {
        if (i > 0)
            sleep(500);
        loaded = launchctl(["bootstrap", domain(uid), paths.plist]).ok;
    }
    if (!loaded) {
        throw new Error(`The job was written to ${paths.plist} but launchd did not load it. Try: launchctl bootstrap ${domain(uid)} ${paths.plist}`);
    }
    return { plist: paths.plist, claude, copied };
}
export function uninstall(paths, deps) {
    if ((deps.platform ?? process.platform) !== "darwin")
        throw new Error(MACOS_ONLY);
    const launchctl = deps.launchctl ?? realLaunchctl;
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    const had = existsSync(paths.plist);
    launchctl(["bootout", domain(uid), paths.plist]);
    rmSync(paths.plist, { force: true });
    rmSync(paths.appDir, { recursive: true, force: true });
    return had;
}
/** Whether the job is installed (the plist is there) and loaded (launchd knows the label). */
export function jobState(paths, deps) {
    if ((deps.platform ?? process.platform) !== "darwin")
        return { installed: false, loaded: false, path: null, node: null };
    const installed = existsSync(paths.plist);
    const uid = deps.uid ?? process.getuid?.() ?? 0;
    const loaded = installed && (deps.launchctl ?? realLaunchctl)(["print", `${domain(uid)}/${LABEL}`]).ok;
    let path = null;
    let node = null;
    if (installed) {
        const xml = readFileSync(paths.plist, "utf8");
        const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
        path = m ? xmlUnescape(m[1]) : null;
        const n = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(xml);
        node = n ? xmlUnescape(n[1]) : null;
    }
    return { installed, loaded, path, node };
}
