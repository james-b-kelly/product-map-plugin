// The background job: a launchd agent that runs `poll` every 60 seconds. macOS only for now.
// `install` copies the built code to ~/.config/product-map/agent-inbox-app (npx's cache can be cleared at any time),
// writes ~/Library/LaunchAgents/com.productmap.agent-inbox.plist and loads it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
export function install(paths, deps) {
    if ((deps.platform ?? process.platform) !== "darwin")
        throw new Error(MACOS_ONLY);
    const { xml: plist, claude: found } = expectedPlist(paths, deps);
    const claude = found.real;
    const root = deps.packageRoot ?? PACKAGE_ROOT;
    if (!existsSync(join(root, "dist", "cli.js")))
        throw new Error("The built code is missing (dist/cli.js). Run this from the published package.");
    // Copy the code, replacing an older copy. No dependencies, so dist/ and package.json are the whole program. Run
    // from that copy itself (the job's own cli.js), there is nothing to copy.
    ensurePrivateDir(paths.configDir);
    if (resolve(root) !== resolve(paths.appDir)) {
        rmSync(paths.appDir, { recursive: true, force: true });
        mkdirSync(paths.appDir, { recursive: true, mode: 0o700 });
        cpSync(join(root, "dist"), join(paths.appDir, "dist"), { recursive: true });
        cpSync(join(root, "package.json"), join(paths.appDir, "package.json"));
        cpSync(join(root, "plist"), join(paths.appDir, "plist"), { recursive: true });
        if (existsSync(join(root, "skill")))
            cpSync(join(root, "skill"), join(paths.appDir, "skill"), { recursive: true });
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
    return { plist: paths.plist, claude };
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
