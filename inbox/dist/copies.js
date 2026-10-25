// Copies of a project's repo that the inbox makes and keeps for itself (PDM-55 WU-02), so a person never has to
// make a worktree or name a branch: the repo and its default branch come from Product Map (`list_repos`, read as
// the person each time), and the copy is a tracked folder like any other (`updateTracked` brings it up to date
// before each run).
//
// The job never clones on its own: Product Map names the repo, and anyone who can edit the project could name one
// the person's GitHub key can read but never meant their agent to (another organisation's, say). So a new copy, a
// changed address, and linking again a copy found in place all need the person's say-so (`consent`: they ran
// `clone` or setup). Without it `ensureCopy` only follows a changed branch and lets go of a copy whose repo was
// removed, and says `needs_consent`.
//
// A copy lives in `<reposDir>/<organisation>/<project>/<repo>`, named only by the repo's name slug, never by its
// address or branch. It is cloned over ssh only (GIT_ALLOW_PROTOCOL=ssh, no file:// or ext::), from an address that
// must be `git@github.com:<owner>/<repo>.git`, with GitHub's own host keys pinned (`GITHUB_HOST_KEYS`, the only
// known_hosts its ssh reads, StrictHostKeyChecking=yes), in batch mode, through the guarded git of git.ts (no hooks,
// no submodules, stdin closed). The clone goes into a temporary folder beside the copy and is renamed into place only
// when it worked, so a failed clone leaves nothing half made. git's message is read only to name the failure
// (`classify`); it is never logged or shown.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { ensurePrivateDir, writePrivate } from "./files.js";
import { isDirectory, linkFor, loadFolders, storeManaged, unlinkLink } from "./folders.js";
import { GIT_TIMEOUT_MS, GUARD, inFolder, parseTrack } from "./git.js";
import { PROJECT_PATTERN, REPO_NAME, REPO_NAME_MAX, SSH_URL } from "./mcp.js";
export const CLONE_TIMEOUT_MS = 5 * 60_000;
/** GitHub's published ssh host keys (https://api.github.com/meta, `ssh_keys`), checked 2026-10-16. */
export const GITHUB_HOST_KEYS = [
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
    "github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
].join("\n") + "\n";
export const SSH_SETUP_URL = "https://docs.github.com/en/authentication/connecting-to-github-with-ssh";
/**
 * What git's message says went wrong. Order matters: a refused key also prints "Could not read from remote
 * repository", so the key comes before the repo.
 */
export function classify(r) {
    const e = r.stderr ?? "";
    if (r.code === "timeout")
        return { kind: "network" };
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key .* (is not known|has changed)/i.test(e))
        return { kind: "host_key" };
    if (/Permission denied \(publickey/i.test(e))
        return { kind: "ssh_key" };
    if (/Repository not found|repository '.*' not found/i.test(e))
        return { kind: "no_access" };
    if (/Remote branch .* not found|couldn't find remote ref/i.test(e))
        return { kind: "no_branch" };
    if (/Could not resolve hostname|Connection timed out|Operation timed out|Network is unreachable|Connection refused|Connection closed by|Connection reset|kex_exchange_identification/i.test(e)) {
        return { kind: "network" };
    }
    return { kind: "other", code: r.code };
}
/** `<owner>/<repo>` from a GitHub ssh address, for the messages. */
export const ownerRepo = (sshUrl) => (sshUrl ?? "").replace(/^git@github\.com:/, "").replace(/\.git$/, "") || "the repo";
/**
 * A failure in plain words, with what to do. It may be held on the person's entry as a note, so it names the repo
 * and the branch (which the project's people can see in Product Map) and never a folder on this Mac.
 */
export function failureMessage(f, repo) {
    const name = ownerRepo(repo.ssh_url);
    switch (f.kind) {
        case "ssh_key":
            return "SSH isn't set up for GitHub on this Mac: GitHub refused the key. " +
                `Set up a key (${SSH_SETUP_URL}) and check it with: ssh -T git@github.com. ` +
                "If your key has a passphrase, add it to the Keychain so the inbox can use it: ssh-add --apple-use-keychain ~/.ssh/<your key>.";
        case "host_key":
            return "GitHub's host key did not match the one the inbox knows, so nothing was cloned. If GitHub has changed its keys, update the inbox.";
        case "no_access":
            return `Your GitHub account can't see ${name}. Ask its owner for access.`;
        case "no_branch":
            return `${name} has no branch called ${repo.default_branch || "(none)"}. Check the default branch in Project settings, Repos.`;
        case "network":
            return "Couldn't reach GitHub. Check this Mac's connection; the inbox tries again later.";
        case "bad_repo":
            return "The repo in Project settings, Repos is not one the inbox can clone: it needs a GitHub repository and a plain branch name.";
        default:
            return `Cloning ${name} failed (git: ${f.code ?? "error"}).`;
    }
}
/** The ssh command a copy's git runs: batch mode, and GitHub's pinned keys as the only known hosts. */
export function pinnedSsh(paths) {
    // The command is run by a shell (core.sshCommand), so the file's path is quoted, and a path that cannot be is refused.
    if (/['\n\\]/.test(paths.knownHosts))
        throw new Error("The inbox's settings folder has a quote or backslash in its path, so it cannot keep copies.");
    let current = "";
    try {
        current = readFileSync(paths.knownHosts, "utf8");
    }
    catch { /* written below */ }
    if (current !== GITHUB_HOST_KEYS)
        writePrivate(paths.knownHosts, GITHUB_HOST_KEYS);
    return `ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile='${paths.knownHosts}' ` +
        "-o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no";
}
/** A branch the inbox will check out: a plain branch name, never HEAD or a full ref, and no part that reads as an option. */
export function branchOk(branch) {
    if (!branch || branch === "HEAD" || branch.startsWith("refs/") || branch !== branch.trim() || /[\u0000-\u001f\u007f]/.test(branch))
        return false;
    try {
        parseTrack(`origin/${branch}`);
        return true;
    }
    catch {
        return false;
    }
}
const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return null;
    }
};
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** Where a project's copy of a repo lives. Throws for a name that could leave the copies folder. */
export function copyPath(paths, project, repo) {
    if (!PROJECT_PATTERN.test(project) || !REPO_NAME.test(repo) || repo.length > REPO_NAME_MAX)
        throw new Error("Not a project and repo name the inbox can keep a copy of.");
    // Lower case, so a project named with other capitals by a request still finds its one copy.
    const [org, proj] = project.toLowerCase().split("/");
    return join(paths.reposDir, org, proj, repo);
}
/** Makes the copies folder and the project's folder in it, 700, refusing a symlink anywhere along the way. */
function ensureFolders(paths, target) {
    ensurePrivateDir(dirname(paths.reposDir));
    ensurePrivateDir(paths.reposDir);
    for (const dir of [dirname(dirname(target)), dirname(target)]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory())
            throw new Error("A folder in the inbox's copies is a symlink.");
    }
    const root = real(paths.reposDir);
    const parent = real(dirname(target));
    if (!root || !parent || !within(parent, root))
        throw new Error("The copy's folder is not inside the inbox's copies.");
}
/**
 * Removes what an earlier clone into this place left behind (a tick stopped part way). Only folders older than a
 * clone may take, so a clone still going in another process is never pulled from under it.
 */
async function removeLeftovers(paths, git, target, now) {
    let names = [];
    try {
        names = readdirSync(dirname(target));
    }
    catch {
        return;
    }
    for (const n of names) {
        const p = join(dirname(target), n);
        let old = false;
        try {
            old = now - lstatSync(p).mtimeMs > CLONE_TIMEOUT_MS + 60_000;
        }
        catch {
            continue;
        }
        if (!old)
            continue;
        try {
            // A clone that never finished holds nothing of anyone's; an old copy set aside by a replace stopped part way
            // goes through retireCopy, so anything in it is kept.
            if (n.startsWith(`${basename(target)}.clone-`))
                rmSync(p, { recursive: true, force: true });
            else if (n.startsWith(`${basename(target)}.old-`))
                await retireCopy(paths, git, p, now);
        }
        catch { /* tried again next time */ }
    }
}
/**
 * Whether git says deleting this copy loses nothing: no changes, no untracked or ignored files, no commit on a branch
 * or HEAD that the remote does not have, and no stash. Anything it cannot tell is a no.
 */
async function nothingToLose(git, folder) {
    // Its own repository, not a folder inside another one (whose status would be that one's).
    const top = await git(inFolder(folder, "rev-parse", "--show-toplevel"), GIT_TIMEOUT_MS);
    if (top.code !== 0 || real(top.stdout.replace(/\n$/, "")) !== real(folder))
        return false;
    const s = await git(inFolder(folder, "status", "--porcelain", "--untracked-files=all", "--ignored"), GIT_TIMEOUT_MS);
    if (s.code !== 0 || s.stdout.trim() !== "")
        return false;
    const local = await git(inFolder(folder, "rev-list", "--max-count=1", "HEAD", "--branches", "--not", "--remotes"), GIT_TIMEOUT_MS);
    if (local.code !== 0 || local.stdout.trim() !== "")
        return false;
    const stash = await git(inFolder(folder, "rev-parse", "--verify", "--quiet", "refs/stash"), GIT_TIMEOUT_MS);
    return stash.code === 1;
}
const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, "-");
/**
 * An old copy the inbox no longer reads: deleted when nothing would be lost (`nothingToLose`), else moved aside to
 * `<copy>.kept-<time>`. Returns where it was kept, or null. Only ever a folder inside the copies folder.
 */
export async function retireCopy(paths, git, folder, now = Date.now()) {
    const root = real(paths.reposDir);
    const rp = real(folder);
    // Only a copy's own place, <organisation>/<project>/<repo>, never a folder holding several.
    if (!root || !rp || !within(rp, root) || relative(root, rp).split(sep).length !== 3)
        return null;
    if (await nothingToLose(git, rp)) {
        rmSync(rp, { recursive: true, force: true });
        return null;
    }
    const kept = `${rp.replace(/\.old-[0-9a-f]+$/, "")}.kept-${stamp(now)}`;
    renameSync(rp, kept);
    return kept;
}
/** Clones `repo` into a fresh folder beside `target` and checks its branch out detached. The folder, or a failure. */
async function cloneBeside(paths, git, repo, target, now) {
    await removeLeftovers(paths, git, target, now);
    const temp = `${target}.clone-${randomBytes(4).toString("hex")}`;
    const ssh = pinnedSsh(paths);
    const done = (failure) => {
        rmSync(temp, { recursive: true, force: true });
        return { failure };
    };
    // --config keeps the pinned ssh command in the copy, so its later fetches (updateTracked, with a copy's git) use it.
    const c = await git([
        ...GUARD, "-c", "protocol.file.allow=never",
        "clone", "--quiet", "--no-checkout", "--no-recurse-submodules", "--origin", "origin",
        "--branch", repo.default_branch, "--config", `core.sshCommand=${ssh}`, "--", repo.ssh_url, temp,
    ], CLONE_TIMEOUT_MS);
    if (c.code !== 0)
        return done(classify(c));
    const co = await git(inFolder(temp, "checkout", "--quiet", "--detach", `refs/remotes/origin/${repo.default_branch}`, "--"), GIT_TIMEOUT_MS);
    if (co.code !== 0)
        return done({ kind: "other", code: co.code });
    return { path: temp };
}
/** Whether a folder in a copy's place is the inbox's clone of this address: the top of a git tree whose origin is it. */
async function isCloneOf(git, folder, sshUrl) {
    const top = await git(inFolder(folder, "rev-parse", "--show-toplevel"), GIT_TIMEOUT_MS);
    if (top.code !== 0 || real(top.stdout.replace(/\n$/, "")) !== real(folder))
        return false;
    const u = await git(inFolder(folder, "config", "--get", "remote.origin.url"), GIT_TIMEOUT_MS);
    return u.code === 0 && u.stdout.trim() === sshUrl;
}
/**
 * Brings a project's copy in line with its repos in Product Map: clones it when there is none, follows a changed
 * default branch, and reclones when the repo itself changed (its address, or which repo). `choose` picks a repo by
 * name; otherwise the copy's own repo, or the only one. Never touches a folder the person linked themselves. The
 * caller holds the inbox's lock, so no other tick or command changes the copies meanwhile.
 *
 * A new copy replaces an old one in this order, so a failure part way leaves a copy that works and a link to it: the
 * clone is made beside the place; the old copy, if it is in the place, is renamed aside; the clone is renamed into
 * the place (the old copy is put back if that fails); the link is stored; only then is the old copy deleted, or kept
 * when it has anything git says would be lost.
 */
export async function ensureCopy(paths, git, project, repos, opts = {}) {
    const now = opts.now ?? Date.now();
    const link = linkFor(loadFolders(paths), project);
    if (link && !link.managed)
        return { kind: "own", link };
    const name = opts.choose ?? link?.managed?.repo;
    const named = name ? repos.find((r) => r.name === name) : undefined;
    const wanted = named ?? (opts.choose ? undefined : repos.length === 1 ? repos[0] : undefined);
    if (!wanted) {
        if (opts.choose)
            return { kind: "several", names: repos.map((r) => r.name) };
        // The copy's repo is gone from Product Map and no single other one replaces it: the copy is let go (kept first
        // if it holds anything, then unlinked, so a failure leaves it linked rather than lost).
        if (link?.managed) {
            if (isDirectory(link.path))
                await retireCopy(paths, git, link.path, now);
            unlinkLink(paths, project);
        }
        return repos.length === 0 ? { kind: "no_repo" } : { kind: "several", names: repos.map((r) => r.name) };
    }
    if (!wanted.ssh_url || !SSH_URL.test(wanted.ssh_url) || !branchOk(wanted.default_branch))
        return { kind: "failed", failure: { kind: "bad_repo" }, repo: wanted };
    const repo = wanted;
    const target = copyPath(paths, project, repo.name);
    const managed = { repo: repo.name, url: repo.ssh_url };
    const store = (path) => storeManaged(paths, project, { path, branch: repo.default_branch, managed });
    const linked = link?.managed ? real(link.path) : null;
    const here = real(target);
    if (link?.managed && linked !== null && linked === here && link.managed.repo === repo.name && link.managed.url === repo.ssh_url) {
        // Only the branch changed, or nothing: the next run's update fetches and checks out the branch.
        const l = link.track === `origin/${repo.default_branch}` ? link : store(here);
        return { kind: "ready", link: l, repo, cloned: false, kept: null };
    }
    if (!opts.consent)
        return { kind: "needs_consent", repo };
    ensureFolders(paths, target);
    // A clone of this address already in the place that is not linked (unlinked and kept, or left by a stop part way)
    // is the copy: it is linked again rather than cloned again, with the pinned ssh set in it (a clone made by hand has
    // none). Only a folder really in the copies folder, not one a symlink there leads to.
    const root = real(paths.reposDir);
    if (here !== null && linked !== here && root !== null && within(here, root) && lstatSync(target).isDirectory() && await isCloneOf(git, here, repo.ssh_url)) {
        const set = await git(inFolder(here, "config", "core.sshCommand", pinnedSsh(paths)), GIT_TIMEOUT_MS);
        if (set.code !== 0)
            return { kind: "failed", failure: { kind: "other", code: set.code }, repo };
        const l = store(here);
        if (link?.managed && linked !== null)
            await retireQuietly(paths, git, linked, now);
        return { kind: "ready", link: l, repo, cloned: false, kept: null };
    }
    const made = await cloneBeside(paths, git, repo, target, now);
    if ("failure" in made)
        return { kind: "failed", failure: made.failure, repo };
    // Whatever is in the place (the old copy, or anything else) is moved aside, never overwritten.
    let aside = null;
    if (lstatExists(target)) {
        aside = `${target}.old-${randomBytes(4).toString("hex")}`;
        renameSync(target, aside);
    }
    try {
        renameSync(made.path, target);
    }
    catch (err) {
        if (aside)
            renameSync(aside, target);
        rmSync(made.path, { recursive: true, force: true });
        throw err;
    }
    const l = store(real(target) ?? target);
    // The new copy is in place and linked: retiring the old one cannot undo that. One that fails is left for the
    // next clone's sweep (`removeLeftovers`), and the copy is still ready.
    let kept = null;
    if (aside)
        kept = await retireQuietly(paths, git, aside, now);
    if (linked !== null && linked !== here && isDirectory(linked))
        kept = (await retireQuietly(paths, git, linked, now)) ?? kept;
    return { kind: "ready", link: l, repo, cloned: true, kept };
}
async function retireQuietly(paths, git, folder, now) {
    try {
        return await retireCopy(paths, git, folder, now);
    }
    catch {
        return null;
    }
}
const lstatExists = (p) => {
    try {
        lstatSync(p);
        return true;
    }
    catch {
        return false;
    }
};
