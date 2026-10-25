// The commands, over a context the tests can fill: login, logout, link, clone, unlink, poll, install, uninstall,
// status. Setup is in setup.ts.
import { existsSync } from "node:fs";
import { freshAuth, loadAuth, login, logout, ServerUnavailable, SignInNeeded } from "./auth.js";
import { ensureCopy, failureMessage, retireCopy } from "./copies.js";
import { isDirectory, linkFor, linkPlain, linkTracked, loadFolders, notAllowed, projectArg, unlinkLink } from "./folders.js";
import { realGit, shortHead } from "./git.js";
import { install, jobState, uninstall } from "./job.js";
import { lockHeld, takeLock } from "./lock.js";
import { listProjects, listRepos, McpClient } from "./mcp.js";
import { serverFrom } from "./paths.js";
import { poll } from "./poll.js";
import { findClaude } from "./run.js";
import { loadSettings, saveSettings } from "./settings.js";
import { loadState } from "./state.js";
const gitOf = (ctx) => ctx.git ?? realGit(ctx.env);
const copyGitOf = (ctx) => ctx.copyGit ?? realGit(ctx.env, { clone: true });
/** An installed job runs its own copy of this package, which may be from before tracking and would ignore it. */
function jobCopyNote(ctx) {
    if (jobState(ctx.paths, ctx.job).installed) {
        ctx.print("The background job runs its own copy of this package: run npx product-map-inbox install so the job's copy follows the track.");
    }
}
const TRACK_NOTE = (track) => `Before each run this folder is fetched and, when it has no changes, checked out at ${track} (detached HEAD). Link a worktree kept for the inbox, not the checkout you work in.`;
export async function loginCommand(ctx, serverFlag) {
    const server = serverFrom(serverFlag, ctx.env);
    const auth = await login(ctx.paths, server, { fetch: ctx.fetch, openBrowser: ctx.openBrowser, print: ctx.print });
    ctx.print(`Signed in to ${auth.server}.`);
}
export async function logoutCommand(ctx) {
    const had = await logout(ctx.paths);
    ctx.print(had ? "Signed out on this machine: the sign-in was deleted." : "Not signed in on this machine.");
    ctx.print("Product Map has no way to end the connection from here: disconnect it on the Connected agents page in Product Map.");
}
const yes = (s) => /^y(es)?$/i.test(s.trim());
/** The projects this sign-in reaches, or null when it cannot say (not signed in, or the server is out of reach). */
async function reachable(ctx) {
    try {
        const auth = await freshAuth(ctx.paths, { fetch: ctx.fetch });
        return await listProjects(new McpClient(ctx.paths, auth, { fetch: ctx.fetch }));
    }
    catch {
        return null;
    }
}
export async function linkCommand(ctx, project, folder, track) {
    if (!folder)
        throw new Error("Usage: product-map-inbox link <organisation>/<project> <folder> [--track <remote>/<branch>]");
    if (track !== undefined) {
        const l = await linkTracked(ctx.paths, project ?? "", folder, ctx.cwd, track, gitOf(ctx));
        ctx.print(`Linked ${project} to ${l.path}, tracking ${l.track}.`);
        ctx.print(TRACK_NOTE(l.track));
        jobCopyNote(ctx);
    }
    else {
        const l = linkPlain(ctx.paths, project ?? "", folder, ctx.cwd);
        ctx.print(`Linked ${project} to ${l.path}.`);
        if (l.stopped)
            ctx.print(`Tracking ${l.stopped} stopped: runs read this folder as it is. Link it again with --track ${l.stopped} to track it.`);
    }
    ctx.print("A run is given this folder's CLAUDE.md and can repeat what it says into a comment: keep nothing secret in it.");
    if (loadAuth(ctx.paths)?.refresh_token) {
        const projects = await reachable(ctx);
        if (projects && !projects.some((p) => p.project.toLowerCase() === (project ?? "").toLowerCase())) {
            ctx.print(`Warning: ${project} is not among the projects this sign-in reaches. Check the name with npx product-map-inbox status.`);
        }
    }
}
/**
 * Makes or updates the copy of a project's repo that the inbox keeps (PDM-55 WU-02): the repo and its default branch
 * come from Product Map. `repo` chooses one when the project has several. A failure is thrown in plain words.
 */
export async function cloneCommand(ctx, project, repo, opts = {}) {
    const key = projectArg(project);
    const auth = await freshAuth(ctx.paths, { fetch: ctx.fetch });
    const repos = await listRepos(new McpClient(ctx.paths, auth, { fetch: ctx.fetch }), key);
    // The say-so is for the repo Product Map names now, which anyone who can edit the project can change: it is named
    // and asked about before anything is cloned (or `--yes`, for a script that has shown it already).
    // Chosen as ensureCopy chooses (the one named, else the copy's own, else the only one), and that one is passed on,
    // so what is asked about is exactly what is cloned. With none chosen, nothing gets the say-so.
    const current = linkFor(loadFolders(ctx.paths), key);
    const name = repo ?? current?.managed?.repo;
    const pick = (name ? repos.find((r) => r.name === name) : undefined) ?? (repo ? undefined : repos.length === 1 ? repos[0] : undefined);
    const already = pick && current?.managed?.url === pick.ssh_url && current.managed.repo === pick.name;
    if (pick?.ssh_url && !already && !opts.yes) {
        const what = `${pick.ssh_url.replace(/^git@github\.com:/, "").replace(/\.git$/, "")} (branch ${pick.default_branch || "none"})`;
        if (!ctx.interactive)
            throw new Error(`This would copy ${what} to this Mac. Run it in a terminal to confirm, or add --yes.`);
        if (!yes(await ctx.ask(`Copy ${what} to this Mac for ${key}'s requests? [y/N] `))) {
            ctx.print("Nothing was copied.");
            return;
        }
    }
    // The job's tick changes copies too: one at a time.
    const lock = takeLock(ctx.paths.lock);
    if (!lock)
        throw new Error("The background job is working right now (a request's run can take up to 15 minutes). Try again when npx product-map-inbox status shows its last tick finished.");
    let r;
    try {
        // Running this command is the person's say-so for this repo (see copies.ts).
        r = await ensureCopy(ctx.paths, copyGitOf(ctx), key, repos, { choose: pick?.name ?? repo, consent: pick !== undefined });
    }
    finally {
        lock.release();
    }
    switch (r.kind) {
        case "own":
            ctx.print(`${key} runs in a folder you linked, ${r.link.path}. Unlink it first (npx product-map-inbox unlink ${key}) to let the inbox keep a copy.`);
            return;
        case "no_repo":
            throw new Error(`${key} has no repo in Product Map. Add one in Project settings, Repos, then run this again.`);
        case "several":
            throw new Error(repo
                ? `${key} has no repo called ${repo}. Its repos: ${r.names.join(", ") || "none"}.`
                : `${key} has several repos (${r.names.join(", ")}). Choose one: npx product-map-inbox clone ${key} --repo <name>.`);
        case "failed":
            throw new Error(failureMessage(r.failure, r.repo));
        case "needs_consent":
            throw new Error(`${key} has several repos (${repos.map((x) => x.name).join(", ")}). Choose one: npx product-map-inbox clone ${key} --repo <name>.`);
        case "ready":
            ctx.print(r.cloned
                ? `Cloned ${r.repo.ssh_url} into ${r.link.path}. Before each run it is brought up to ${r.link.track}.`
                : `${key} already has its copy at ${r.link.path}, tracking ${r.link.track}.`);
            if (r.kept)
                ctx.print(`The old copy had changes, so it was moved to ${r.kept}, not deleted.`);
            if (!existsSync(`${r.link.path}/CLAUDE.md`))
                ctx.print("The copy has no CLAUDE.md, so runs have only the code to go on.");
            jobCopyNote(ctx);
    }
}
/** Turns web access for runs on this Mac on or off, or says which it is. */
export function webCommand(ctx, value) {
    if (value === "on" || value === "off") {
        saveSettings(ctx.paths, { ...loadSettings(ctx.paths), web: value === "on" });
        ctx.print(value === "on"
            ? "Web access on: runs may use WebFetch and WebSearch. A page's text can try to steer a run, so turn it off if you don't need it."
            : "Web access off: runs read only the linked folder and Product Map.");
    }
    else if (value === undefined)
        ctx.print(`Web access: ${loadSettings(ctx.paths).web ? "on" : "off"}.`);
    else
        throw new Error("Usage: product-map-inbox web [on|off]");
}
export async function unlinkCommand(ctx, project) {
    const old = unlinkLink(ctx.paths, project ?? "");
    if (!old) {
        ctx.print(`${project} had no folder.`);
        return;
    }
    ctx.print(`Unlinked ${project}.`);
    if (!old.managed || !isDirectory(old.path))
        return;
    // The inbox made this copy, so it offers to remove it; a copy with changes is moved aside, never deleted.
    if (ctx.interactive && yes(await ctx.ask(`Delete the inbox's copy at ${old.path}? [y/N] `))) {
        const lock = takeLock(ctx.paths.lock);
        if (!lock) {
            ctx.print(`The background job is working right now, so the copy was kept at ${old.path}. Delete it later.`);
            return;
        }
        try {
            const kept = await retireCopy(ctx.paths, gitOf(ctx), old.path);
            ctx.print(kept ? `It had something git says would be lost, so it was moved to ${kept}, not deleted.` : "Deleted.");
        }
        finally {
            lock.release();
        }
    }
    else
        ctx.print(`The inbox's copy is still at ${old.path}.`);
}
export async function pollCommand(ctx) {
    await poll(ctx.paths, { env: ctx.env, fetch: ctx.fetch, show: ctx.env.PRODUCT_MAP_INBOX_SHOW_OUTPUT === "1" });
}
export function installCommand(ctx) {
    const done = install(ctx.paths, ctx.job);
    ctx.print(`Job installed: ${done.plist} (every 60 seconds), running Claude Code from ${done.claude}. Log: ${ctx.paths.log}`);
}
export async function uninstallCommand(ctx) {
    ctx.print(uninstall(ctx.paths, ctx.job) ? "Job removed." : "The job was not installed.");
    if (ctx.interactive && loadAuth(ctx.paths)?.refresh_token) {
        if (yes(await ctx.ask("Also sign out on this machine? [y/N] ")))
            await logoutCommand(ctx);
    }
}
export async function statusCommand(ctx) {
    const state = loadState(ctx.paths, () => ctx.print("Note: the job's state file could not be read; it starts again empty."));
    let auth = null;
    try {
        auth = loadAuth(ctx.paths);
    }
    catch {
        ctx.print("Note: the sign-in file could not be read.");
    }
    if (!auth || !auth.refresh_token) {
        ctx.print("Sign-in: not signed in. Run npx product-map-inbox login.");
    }
    else {
        ctx.print(`Sign-in: ${auth.server}, since ${auth.signed_in_at}.`);
        // A tick may be refreshing or using the sign-in; status never refreshes under it.
        const tickRunning = lockHeld(ctx.paths.lock);
        const fresh = auth.access_token && auth.expires_at - Date.now() > 60_000;
        if (tickRunning && !fresh) {
            ctx.print("  A tick is running; the projects are not listed now.");
        }
        else {
            try {
                const now = tickRunning ? auth : await freshAuth(ctx.paths, { fetch: ctx.fetch });
                const projects = await listProjects(new McpClient(ctx.paths, now, { fetch: ctx.fetch }));
                const orgs = [...new Set(projects.map((p) => p.organisation))];
                ctx.print(`  Reaches ${projects.length} project${projects.length === 1 ? "" : "s"}${orgs.length ? ` in ${orgs.join(", ")}` : ""}:`);
                for (const p of projects)
                    ctx.print(`    ${p.project} (${p.role})`);
            }
            catch (err) {
                if (err instanceof SignInNeeded || err instanceof ServerUnavailable)
                    ctx.print(`  ${err.message}`);
                else
                    ctx.print("  The projects could not be listed.");
            }
        }
    }
    const folders = loadFolders(ctx.paths, (what) => ctx.print(what === "folders_unreadable"
        ? "Note: the folders file could not be read."
        : "Note: the folders file names a track that is not a safe branch name or not a linked project; it is ignored."));
    const keys = Object.keys(folders);
    ctx.print(keys.length ? "Folders:" : "Folders: none. Link one with npx product-map-inbox link <organisation>/<project> <folder>.");
    for (const k of keys) {
        const l = folders[k];
        const here = isDirectory(l.path);
        let tracking = "";
        if (l.track) {
            const head = here ? await shortHead(gitOf(ctx), l.path) : null;
            const last = Object.entries(state.tracks).find(([p]) => p.toLowerCase() === k.toLowerCase())?.[1];
            const lastText = !last ? ", last update: none yet"
                : last.outcome === "updated" ? `, last update: ${last.at}`
                    : `, last update: ${last.outcome.replace(/_/g, " ")} since ${last.since}`;
            tracking = `, tracking ${l.track}${head ? `, at ${head}` : ""}${lastText}`;
        }
        const kept = l.managed ? `, a copy of ${l.managed.repo} kept by the inbox` : "";
        ctx.print(`  ${k} -> ${l.path}${kept}${tracking}${here ? "" : " (missing)"}`);
        const refused = notAllowed(l, ctx.paths);
        if (refused)
            ctx.print(`    ${refused}`);
    }
    const failed = Object.entries(state.copies);
    if (failed.length) {
        ctx.print("Copies the inbox could not make (tried again on the next request, at most every 10 minutes):");
        for (const [p, c] of failed) {
            ctx.print(`  ${p}, ${new Date(c.at).toISOString()}: ${c.note || "the check could not finish (Product Map out of reach, or this Mac's files); see the log."}`);
        }
    }
    ctx.print(`Web access for runs: ${loadSettings(ctx.paths).web ? "on" : "off"}.`);
    const job = jobState(ctx.paths, ctx.job);
    if ((ctx.job.platform ?? process.platform) !== "darwin")
        ctx.print("Job: macOS only for now.");
    else {
        ctx.print(`Job: ${job.installed ? (job.loaded ? "installed and loaded" : "installed, not loaded") : "not installed"}.`);
        if (job.installed && job.node && !existsSync(job.node)) {
            ctx.print(`  The job's Node (${job.node}) is gone, so the job cannot start. Run npx product-map-inbox setup again.`);
        }
    }
    const claude = findClaude(job.path ?? ctx.env.PATH, ctx.paths.home, ctx.job.claudeDirs);
    if (!claude || state.claude_missing) {
        const where = job.path ? `the job's PATH (${job.path})` : "your PATH";
        ctx.print(`Claude Code: not found in ~/.claude/local, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin or ${where}. Install it, then run npx product-map-inbox install again.`);
    }
    else {
        ctx.print(`Claude Code: ${claude.real}${claude.real !== claude.found ? ` (from ${claude.found})` : ""}.`);
    }
    const stuck = state.attempts.filter((a) => a.gave_up || a.count > 1);
    if (stuck.length) {
        ctx.print("Requests that did not get answered:");
        for (const a of stuck)
            ctx.print(`  ${a.project} ${a.entry} (${a.id}): ${a.count} run${a.count === 1 ? "" : "s"}${a.gave_up ? ", given up" : ""}`);
    }
    const t = state.last_tick;
    if (!t)
        ctx.print("Last tick: none yet.");
    else {
        const extra = t.outcome === "ran" ? `, ran a request, exit ${t.exit ?? "-"}${t.timed_out ? " (timed out)" : ""}` : "";
        ctx.print(`Last tick: ${t.at}, ${t.outcome}${t.requests !== undefined ? `, ${t.requests} waiting` : ""}${extra}.`);
    }
}
