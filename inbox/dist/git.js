// A linked folder can track a git branch (`link … --track origin/develop`), so each run reads current code: before a
// run the folder is fetched and, when it has no changes, checked out (detached) at the tracked branch.
//
// Every git call is `git <GUARD> -C <folder> …` through spawn (never a shell), in its own process group (a timeout
// kills ssh and any remote helper with it), with stdin ignored and a short environment (PATH, HOME, SSH_AUTH_SOCK and
// GIT_SSH_COMMAND when set, GIT_TERMINAL_PROMPT=0, a no-op GIT_ASKPASS), so a fetch that wants a password fails
// instead of waiting. The folder's own hooks and fsmonitor never run, and no gc, ext:: transport or submodule work
// happens. The names given to git are checked against a strict pattern first, and `--` ends the options.
import { spawn } from "node:child_process";
import { readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { insideFolder, isSecretPath } from "./hook.js";
export const FETCH_TIMEOUT_MS = 60_000;
export const GIT_TIMEOUT_MS = 30_000;
/** On every git call: nothing from the folder runs, and no background work starts. */
export const GUARD = [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0",
    "-c", "protocol.ext.allow=never", "-c", "submodule.recurse=false",
];
/** For a fetch over ssh when neither GIT_SSH_COMMAND nor core.sshCommand says otherwise: never ask, give up soon. */
const BATCH_SSH = "core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15";
const NO_ASKPASS = "/usr/bin/true";
const NAME = /^[A-Za-z0-9._/-]+$/;
/** `<remote>/<branch>` split and checked, or an Error saying what a name may hold. */
export function parseTrack(value) {
    const v = (value ?? "").trim();
    const bad = new Error("Name the branch to track as <remote>/<branch>, such as origin/develop: letters, digits and . _ / - only.");
    const slash = v.indexOf("/");
    if (v.length > 200 || slash <= 0 || !NAME.test(v) || v.includes("..") || v.includes("//") || v.endsWith("/"))
        throw bad;
    const remote = v.slice(0, slash);
    const branch = v.slice(slash + 1);
    // As git's own ref rules, and so that no name can read as an option.
    for (const part of [remote, ...branch.split("/")]) {
        if (!part || part.startsWith("-") || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
            throw bad;
    }
    return { remote, branch };
}
export const trackName = (t) => `${t.remote}/${t.branch}`;
/** The remote-tracking ref, named in full so a local branch called `origin/develop` is never picked instead. */
const trackRef = (t) => `refs/remotes/${t.remote}/${t.branch}`;
/** Fetched with an explicit refspec, so a narrow clone or a custom remote.<name>.fetch cannot leave the ref stale. */
const refspec = (t) => `+refs/heads/${t.branch}:${trackRef(t)}`;
/**
 * The environment git runs with. For a copy the inbox keeps (`clone`), git may use only ssh, and the person's
 * GIT_SSH_COMMAND is left out, so the ssh command with GitHub's pinned host keys (copies.ts) is the one that runs.
 */
export function gitEnv(env, opts = {}) {
    const out = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: NO_ASKPASS, GIT_OPTIONAL_LOCKS: "0" };
    const keep = opts.clone ? ["PATH", "HOME", "SSH_AUTH_SOCK"] : ["PATH", "HOME", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"];
    for (const k of keep)
        if (env[k])
            out[k] = env[k];
    if (opts.clone)
        out.GIT_ALLOW_PROTOCOL = "ssh";
    return out;
}
const killGroup = (pid) => {
    if (!pid)
        return;
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch { /* gone */ }
};
/** The process groups of the git calls still going, so a signal's cleanup can end them before the lock goes. */
const live = new Set();
export const liveGitPids = () => [...live];
/** Kills every git call still going, with its whole process group. */
export function killLiveGit() {
    for (const pid of live)
        killGroup(pid);
    live.clear();
}
export const MAX_OUTPUT = 4 << 20;
export const MAX_STDERR = 16 << 10;
export function realGit(env, opts = {}) {
    const e = gitEnv(env, { clone: opts.clone });
    const max = opts.maxOutput ?? MAX_OUTPUT;
    return (args, timeoutMs) => new Promise((resolve) => {
        let done = false;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timer;
        let pid;
        const finish = (r) => {
            if (pid !== undefined)
                live.delete(pid);
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            resolve(r);
        };
        let child;
        try {
            child = spawn("git", args, { env: e, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true });
        }
        catch (err) {
            resolve({ code: err.code ?? "error", stdout: "" });
            return;
        }
        pid = child.pid;
        if (pid !== undefined)
            live.add(pid);
        timer = setTimeout(() => {
            killGroup(child.pid);
            finish({ code: "timeout", stdout: "" });
        }, timeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
            if (truncated)
                return;
            if (stdout.length + chunk.length > max) {
                truncated = true;
                stdout = "";
                return;
            }
            stdout += chunk;
        });
        // Kept to the cap and read on, so git never blocks on a full pipe.
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => {
            if (stderr.length < MAX_STDERR)
                stderr = (stderr + chunk).slice(0, MAX_STDERR);
        });
        child.on("error", (err) => finish({ code: err.code ?? "error", stdout: "", stderr }));
        child.on("close", (code, signal) => {
            if (code === 0 && truncated)
                finish({ code: "truncated", stdout: "", stderr });
            else
                finish({ code: code ?? signal ?? "error", stdout: code === 0 ? stdout : "", stderr });
        });
    });
}
export const inFolder = (folder, ...args) => [...GUARD, "-C", folder, ...args];
const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return null;
    }
};
/** Whether `folder` is the top of a git working tree (not a folder inside one, whose checkout would rewrite more). */
async function isTopLevel(git, folder) {
    const r = await git(inFolder(folder, "rev-parse", "--show-toplevel"), GIT_TIMEOUT_MS);
    const top = r.code === 0 ? r.stdout.replace(/\n$/, "") : "";
    return top !== "" && real(top) !== null && real(top) === real(folder);
}
/** The fetch, with a batch-mode ssh unless the person set their own ssh command. */
async function fetchTrack(git, folder, t) {
    const own = await git(inFolder(folder, "config", "--get", "core.sshCommand"), GIT_TIMEOUT_MS);
    const ssh = own.code === 0 ? [] : ["-c", BATCH_SSH];
    return git([...ssh, ...inFolder(folder, "fetch", "--quiet", "--no-recurse-submodules", "--", t.remote, refspec(t))], FETCH_TIMEOUT_MS);
}
/**
 * For `link --track`: the folder is the top of a git working tree, the remote is configured, and the branch fetches
 * and names a commit. Throws an Error saying which failed.
 */
export async function checkTrack(git, folder, track) {
    const w = await git(inFolder(folder, "rev-parse", "--is-inside-work-tree"), GIT_TIMEOUT_MS);
    if (w.code !== 0 || w.stdout.trim() !== "true")
        throw new Error(`${folder} is not a git working tree, so it cannot track a branch.`);
    if (!(await isTopLevel(git, folder))) {
        throw new Error(`${folder} is inside a git working tree but is not its top folder. Link the top of the repository (or a worktree of it).`);
    }
    const u = await git(inFolder(folder, "config", "--get", `remote.${track.remote}.url`), GIT_TIMEOUT_MS);
    if (u.code !== 0)
        throw new Error(`${folder} has no remote called ${track.remote}.`);
    const f = await fetchTrack(git, folder, track);
    if (f.code !== 0)
        throw new Error(`Could not fetch ${trackName(track)} in ${folder} (git: ${f.code}). Check the branch, and that git can fetch without asking for a password.`);
    const v = await git(inFolder(folder, "rev-parse", "--verify", "--quiet", `${trackRef(track)}^{commit}`), GIT_TIMEOUT_MS);
    if (v.code !== 0)
        throw new Error(`${trackName(track)} names no commit in ${folder}.`);
}
/** The folder's current commit, short, or null. */
export async function shortHead(git, folder) {
    const r = await git(inFolder(folder, "rev-parse", "--short", "HEAD"), GIT_TIMEOUT_MS);
    const h = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{4,64}$/.test(h) ? h : null;
}
/**
 * Whether every symlink git tracks in the folder stays inside it and away from secret files. Null when that could
 * not be read (the caller treats that as a no).
 */
export async function symlinksStayIn(git, folder) {
    // Any failure, a cut-short listing included, is a no: a symlink past the cut would go unseen.
    const r = await git(inFolder(folder, "ls-files", "-s", "-z"), GIT_TIMEOUT_MS);
    if (r.code !== 0)
        return null;
    const root = real(folder);
    if (!root)
        return null;
    for (const rec of r.stdout.split("\0")) {
        // "<mode> <object> <stage>\t<path>"
        const tab = rec.indexOf("\t");
        if (tab < 0 || !rec.startsWith("120000 "))
            continue;
        const link = join(root, rec.slice(tab + 1));
        let target;
        try {
            target = resolve(dirname(link), readlinkSync(link));
        }
        catch {
            continue; /* not on disk (sparse, or changed) */
        }
        const rel = insideFolder(target, root);
        if (rel === null || (rel !== "" && isSecretPath(rel)))
            return false;
    }
    return true;
}
/** Whether a run may go on after this outcome: every one but a symlink out of the folder. */
export const mayRun = (u) => u.outcome !== "symlink_out";
/**
 * Before a run: fetch the tracked branch, and when the tree has no changes (tracked or untracked, every untracked
 * file listed), check it out detached. Then every tracked symlink must stay inside the folder and off secret files,
 * whatever the update did, or the outcome is `symlink_out` and the run does not start. Never throws.
 */
export async function updateTracked(git, folder, track) {
    try {
        if (!(await isTopLevel(git, folder)))
            return { outcome: "not_toplevel" };
        const r = await update(git, folder, track);
        if ((await symlinksStayIn(git, folder)) !== true)
            return { outcome: "symlink_out" };
        return r;
    }
    catch {
        return { outcome: "fetch_failed", code: "error" };
    }
}
async function update(git, folder, track) {
    // A remote that was removed would make git read the name as a path, such as a folder of that name in the tree.
    const u = await git(inFolder(folder, "config", "--get", `remote.${track.remote}.url`), GIT_TIMEOUT_MS);
    if (u.code !== 0)
        return { outcome: "fetch_failed", code: u.code === 1 ? "no_remote" : u.code };
    const f = await fetchTrack(git, folder, track);
    if (f.code !== 0)
        return { outcome: "fetch_failed", code: f.code };
    const s = await git(inFolder(folder, "status", "--porcelain", "--untracked-files=all"), GIT_TIMEOUT_MS);
    if (s.code !== 0)
        return { outcome: "status_failed", code: s.code };
    if (s.stdout.trim() !== "")
        return { outcome: "dirty" };
    const c = await git(inFolder(folder, "checkout", "--quiet", "--detach", trackRef(track), "--"), GIT_TIMEOUT_MS);
    if (c.code !== 0)
        return { outcome: "checkout_failed", code: c.code };
    return { outcome: "updated", commit: await shortHead(git, folder) };
}
