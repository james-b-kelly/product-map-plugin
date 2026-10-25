// One tick of the job: take the lock, list the person's requests, hold each one whose project has no folder here
// (once per request), and run Claude Code for the oldest request that can run now. One run per tick.
//
// A request whose runs never finish it (the run fails, or is killed) is tried again at most every BACKOFF_MS and
// given up after MAX_ATTEMPTS: it is then held once with GAVE_UP_NOTE, and the others go on. A changed prompt
// starts its count again.
//
// A folder that tracks a git branch is fetched and, when it has no changes, checked out at that branch before its run
// (`updateTracked`). Whatever happens there is logged in one line and the run goes on with the code as it is.
//
// A project with waiting requests and no folder of the person's own is checked against its repos in Product Map
// (copies.ts, PDM-55 WU-02), read as the person on every tick that needs them. The job never clones: a project with
// a repo and no copy, or whose copy's address changed, is held saying to run `clone` (the person's say-so). It does
// follow a copy's changed branch, and lets go of a copy whose repo was removed. A check that fails is held on the
// project's requests in plain words (once each) and tried again no sooner than BACKOFF_MS later.
import { execFileSync } from "node:child_process";
import { freshAuth, ServerUnavailable, SignInNeeded } from "./auth.js";
import { ensureCopy, failureMessage } from "./copies.js";
import { folderFor, linkFor, loadFolders, notAllowed, trackFor } from "./folders.js";
import { killLiveGit, mayRun, parseTrack, realGit, updateTracked } from "./git.js";
import { takeLock } from "./lock.js";
import { errName, logLine } from "./log.js";
import { GAVE_UP_NOTE, holdAgentRequest, listAgentRequests, listRepos, McpClient, NO_FOLDER_NOTE, ReposRefused } from "./mcp.js";
import { buildCommand, findClaude, HOOK_SCRIPT, killGroup, removeRunFiles, RUN_TIMEOUT_MS, runCommand, runEnv, runFiles, writeRunFiles, } from "./run.js";
import { loadSettings } from "./settings.js";
import { loadState, noteTrack, saveState } from "./state.js";
import { existsSync } from "node:fs";
/** A run may last 15 minutes, so the access token must outlive it: refreshed when under 20 minutes are left. */
const TOKEN_MARGIN_MS = RUN_TIMEOUT_MS + 5 * 60_000;
export const BACKOFF_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
/** Held on a project's requests when it has several repos and none is chosen for this Mac. */
export const SEVERAL_REPOS_NOTE = "This project has several repos. Choose the one your agent reads: npx product-map-inbox clone <organisation>/<project> --repo <name>.";
/** Said after a copy's failure when it is held on a request. */
export const SET_UP_HINT = "Then run npx product-map-inbox clone for this project, or wait: the inbox tries again.";
/** After this many checks in a row that could not finish, the requests are held saying so. */
export const ERRORS_BEFORE_HOLD = 3;
/** Held when the check of a project's copy keeps failing for a reason the inbox cannot name. */
export const COPY_ERROR_NOTE = "Your agent could not check its copy of this project's repo. Run npx product-map-inbox status on your Mac.";
/** Held when the person has not said the inbox may copy this repo to their Mac. */
export const consentNote = (project, sshUrl) => `Your agent needs your OK to copy ${(sshUrl ?? "").replace(/^git@github\.com:/, "").replace(/\.git$/, "") || "this project's repo"} to your Mac. Run npx product-map-inbox clone ${project} on it.`;
export const realPs = (pid) => {
    try {
        const out = execFileSync("ps", ["-o", "pgid=,command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const m = /^(\d+)\s+([\s\S]*)$/.exec(out);
        return m ? { pgid: Number(m[1]), command: m[2] } : null;
    }
    catch {
        return null;
    }
};
/**
 * Whether a recorded run is still this job's run, so a recycled pid is never killed: the pid leads its own process
 * group (the run was started detached) and its command line carries the run's own session id.
 */
export function isOurRunWith(ps) {
    return (running) => {
        if (!Number.isInteger(running.pid) || running.pid <= 1 || !/^[A-Za-z0-9-]{8,}$/.test(running.session))
            return false;
        const p = ps(running.pid);
        return p !== null && p.pgid === running.pid && p.command.includes(running.session);
    };
}
const empty = () => ({ held: [], attempts: [], running: null, last_tick: null, claude_missing: false, tracks: {}, copies: {} });
/** The requests that may run now, oldest first, and the attempts brought up to date with the list. */
export function plan(requests, attempts, hasFolder, now) {
    const listed = new Map(requests.map((r) => [r.request, r]));
    // Forget requests no longer listed, and start again for one whose prompt changed.
    const kept = attempts.filter((a) => listed.has(a.id) && listed.get(a.id).prompt_hash === a.prompt_hash);
    const byId = new Map(kept.map((a) => [a.id, a]));
    const giveUp = [];
    const runnable = [];
    for (const r of requests) {
        if (!hasFolder(r))
            continue;
        const a = byId.get(r.request);
        if (a?.gave_up)
            continue;
        if (a && now - a.last_at < BACKOFF_MS)
            continue;
        if (a && a.count >= MAX_ATTEMPTS) {
            giveUp.push(r);
            continue;
        }
        runnable.push(r);
    }
    return { attempts: kept, giveUp, runnable };
}
export async function poll(paths, deps) {
    const now = deps.now ?? Date.now;
    const log = (event, fields = {}) => logLine(paths.log, event, fields);
    const lock = takeLock(paths.lock, { now });
    if (!lock) {
        log("tick", { outcome: "skipped", reason: "running" });
        return { at: new Date(now()).toISOString(), outcome: "skipped" };
    }
    let state = empty();
    const tick = { at: new Date(now()).toISOString(), outcome: "ok" };
    const files = runFiles(paths);
    let cleanup = null;
    try {
        state = loadState(paths, (what) => log("state", { outcome: "reset", reason: what }));
        // Whatever a tick that died left behind: its run's files, and its run if it is still going.
        removeRunFiles(files);
        if (state.running) {
            if ((deps.isOurRun ?? isOurRunWith(realPs))(state.running)) {
                killGroup(state.running.pid, "SIGKILL");
                log("run", { outcome: "killed_leftover" });
            }
            state.running = null;
        }
        const claude = findClaude(deps.env.PATH, paths.home, deps.claudeDirs);
        state.claude_missing = claude === null;
        if (!claude) {
            tick.outcome = "no_claude";
            log("tick", { outcome: "no_claude", reason: "claude_not_found" });
            return tick;
        }
        const auth = await freshAuth(paths, { fetch: deps.fetch, now, marginMs: TOKEN_MARGIN_MS });
        const client = new McpClient(paths, auth, { fetch: deps.fetch, now });
        const requests = (await listAgentRequests(client)).sort((a, b) => a.asked_at.localeCompare(b.asked_at));
        const noteFolders = (what) => log("folders", { outcome: what === "folders_unreadable" ? "reset" : "dropped", reason: what });
        let folders = loadFolders(paths, noteFolders);
        // Copies the inbox keeps: made, followed or replaced before anything is held or run. A project whose copy is
        // waiting for a later tick, or whose check threw, is not held this tick (a hold is once, so it must say the
        // right thing); one whose copy failed is held with what went wrong; one with no repo is held as before.
        const copyNotes = new Map();
        const deferred = new Set();
        // Projects whose copy, if any, is not to be read: its repo's address changed and the person has not said yes.
        const blocked = new Set();
        const copyCleanup = signalCleanup(deps.signals !== false, () => null, files, lock, () => log("copy", { outcome: "stopped", reason: "signal" }));
        try {
            const copyGit = deps.copyGit ?? realGit(deps.env, { clone: true });
            const projects = [...new Map(requests.map((r) => [r.project.toLowerCase(), r.project])).values()];
            // A failure kept for a project that no longer has requests, or that now runs in a folder of the person's own,
            // is forgotten: status lists only what still matters.
            for (const k of Object.keys(state.copies)) {
                const l = linkFor(folders, k);
                if (!projects.some((p) => p.toLowerCase() === k.toLowerCase()) || (l && !l.managed))
                    delete state.copies[k];
            }
            for (const project of projects) {
                const id = project.toLowerCase();
                const l = linkFor(folders, project);
                if (l && !l.managed)
                    continue;
                const usable = folderFor(folders, project, paths) !== null;
                const failed = state.copies[id];
                // Inside the back-off nothing is tried, whether or not a copy is there to use meanwhile.
                if (failed && now() - failed.at < BACKOFF_MS) {
                    if (!usable) {
                        if (failed.note)
                            copyNotes.set(id, failed.note);
                        else
                            deferred.add(id);
                    }
                    continue;
                }
                let r;
                try {
                    r = await ensureCopy(paths, copyGit, project, await listRepos(client, project), { now: now() });
                }
                catch (err) {
                    // A refusal is an answer: with no copy, the requests are held as having no folder, as before. Anything
                    // else (Product Map out of reach, a rename refused), or a refusal for a project that has a copy, is not
                    // final: tried again after the back-off, and the requests are not held on it.
                    if (err instanceof ReposRefused && !l) {
                        log("copy", { outcome: "refused" });
                        continue;
                    }
                    // A blip holds nothing; one that keeps happening is said, so the requests do not wait unseen.
                    const count = (failed?.kind === "error" ? failed.count ?? 1 : 0) + 1;
                    const note = count >= ERRORS_BEFORE_HOLD ? COPY_ERROR_NOTE : "";
                    state.copies[id] = { kind: "error", note, at: now(), count };
                    if (note)
                        copyNotes.set(id, note);
                    else
                        deferred.add(id);
                    log("copy", { outcome: "error", error: errName(err) });
                    continue;
                }
                // Any answer but a failure ends the back-off.
                if (r.kind !== "failed")
                    delete state.copies[id];
                if (r.kind === "failed") {
                    const note = `${failureMessage(r.failure, r.repo)} ${SET_UP_HINT}`;
                    state.copies[id] = { kind: r.failure.kind, note, at: now() };
                    copyNotes.set(id, note);
                    log("copy", { outcome: "failed", reason: r.failure.kind, ...(r.failure.code !== undefined ? { code: r.failure.code } : {}) });
                }
                else if (r.kind === "several")
                    copyNotes.set(id, SEVERAL_REPOS_NOTE);
                else if (r.kind === "needs_consent") {
                    blocked.add(id);
                    copyNotes.set(id, consentNote(project, r.repo.ssh_url));
                    log("copy", { outcome: "needs_consent" });
                }
            }
        }
        finally {
            copyCleanup();
        }
        folders = loadFolders(paths, noteFolders);
        // A folder linked before a rule refused it is not used: said in the log (never the folder), and by status.
        for (const project of new Set(requests.map((r) => r.project.toLowerCase()))) {
            const l = linkFor(folders, project);
            if (l && notAllowed(l, paths))
                log("folder", { outcome: "not_allowed" });
        }
        const hasFolder = (r) => !blocked.has(r.project.toLowerCase()) && folderFor(folders, r.project, paths) !== null;
        const listed = new Set(requests.map((r) => r.request));
        const held = new Set(state.held.filter((id) => listed.has(id)));
        state.held = [...held];
        tick.requests = requests.length;
        // A hold that fails is logged and the tick goes on: it never stops the run below.
        let heldNow = 0;
        const hold = async (r, note) => {
            held.add(r.request);
            state.held = [...held];
            try {
                if (await holdAgentRequest(client, r.request, note))
                    heldNow++;
                else
                    log("hold", { request: r.request, outcome: "refused" });
            }
            catch (err) {
                log("hold", { request: r.request, outcome: "error", error: errName(err) });
            }
        };
        for (const r of requests) {
            if (!hasFolder(r) && !held.has(r.request) && !deferred.has(r.project.toLowerCase()))
                await hold(r, copyNotes.get(r.project.toLowerCase()) ?? NO_FOLDER_NOTE);
        }
        const t = now();
        const p = plan(requests, state.attempts, hasFolder, t);
        state.attempts = p.attempts;
        for (const r of p.giveUp) {
            const a = state.attempts.find((x) => x.id === r.request);
            if (a)
                a.gave_up = true;
            if (!held.has(r.request))
                await hold(r, GAVE_UP_NOTE);
            log("request", { request: r.request, outcome: "gave_up" });
        }
        tick.held = heldNow;
        const next = p.runnable[0];
        if (!next) {
            tick.ran = null;
            log("tick", { outcome: "ok", requests: requests.length, held: heldNow, run: null });
            return tick;
        }
        // Counted before the run, so a tick that dies part way still counts it.
        let attempt = state.attempts.find((a) => a.id === next.request);
        if (!attempt) {
            attempt = { id: next.request, project: next.project, entry: next.entry, count: 0, last_at: t, prompt_hash: next.prompt_hash, gave_up: false };
            state.attempts.push(attempt);
        }
        attempt.count++;
        attempt.last_at = t;
        saveState(paths, state);
        // Without the guard there is no run: the hook command fails closed, but a run that cannot be guarded is not started.
        const node = deps.node ?? process.execPath;
        const hookScript = deps.hookScript ?? HOOK_SCRIPT;
        if (!existsSync(node) || !existsSync(hookScript)) {
            tick.outcome = "error";
            log("tick", { outcome: "error", reason: "guard_missing" });
            return tick;
        }
        // The signal handlers go in before the folder's update and before any run file is written, so a signal at any
        // point (a slow fetch included) removes them and lets the lock go.
        let runPid = null;
        cleanup = signalCleanup(deps.signals !== false, () => runPid, files, lock, () => {
            state.running = null;
            try {
                saveState(paths, state);
            }
            catch { /* best effort */ }
            log("run", { request: next.request, outcome: "stopped", reason: "signal" });
        });
        const folder = folderFor(folders, next.project, paths);
        const track = trackFor(folders, next.project);
        // A copy the inbox keeps is fetched with a copy's git too: ssh only, and its own pinned ssh command, never the
        // person's GIT_SSH_COMMAND.
        const managed = linkFor(folders, next.project)?.managed !== undefined;
        let staleTrack;
        if (track) {
            const trackGit = managed ? (deps.copyGit ?? realGit(deps.env, { clone: true })) : (deps.git ?? realGit(deps.env));
            const u = await updateFolder(folder, track, trackGit, (fields) => log("track", { request: next.request, ...fields }));
            noteTrack(state, next.project, u.outcome, u.outcome === "updated" ? u.commit : null, new Date(now()).toISOString());
            saveState(paths, state);
            if (!mayRun(u)) {
                // A tracked symlink leads out of the folder or to a secret: no run. The attempt counts, so it is given up
                // after three like any request that does not get answered.
                tick.ran = null;
                log("tick", { outcome: "ok", requests: requests.length, held: heldNow, run: null, reason: u.outcome });
                return tick;
            }
            if (u.outcome !== "updated")
                staleTrack = track;
            // The update can take a minute and a half: a request cancelled meanwhile is not run.
            try {
                if (!(await listAgentRequests(client)).some((r) => r.request === next.request)) {
                    tick.ran = null;
                    log("request", { request: next.request, outcome: "gone" });
                    return tick;
                }
            }
            catch { /* the run's take decides */ }
        }
        // The client may have refreshed on a 401 (and a fetch can take a minute); read the sign-in again so the run's
        // token outlives the run.
        const runAuth = await freshAuth(paths, { fetch: deps.fetch, now, marginMs: TOKEN_MARGIN_MS });
        const req = { project: next.project, request: next.request, entry: next.entry, preset: next.preset };
        const web = loadSettings(paths).web;
        const cmd = buildCommand({ claude: claude.real, req, folder, files, web });
        tick.outcome = "ran";
        tick.ran = next.request;
        log("tick", { outcome: "ran", requests: requests.length, held: heldNow, run: next.request, attempt: attempt.count, session: cmd.sessionId });
        writeRunFiles(files, { server: runAuth.server, accessToken: runAuth.access_token, req, node, sessionId: cmd.sessionId, folder, hookScript, staleTrack, web });
        saveState(paths, state);
        const result = await runCommand(cmd, {
            env: runEnv(deps.env), spawn: deps.spawn, timeoutMs: deps.timeoutMs, graceMs: deps.graceMs, now, show: deps.show,
            onStart: (pid) => {
                runPid = pid;
                state.running = { pid, started_at: now(), session: cmd.sessionId };
                try {
                    saveState(paths, state);
                }
                catch { /* best effort */ }
            },
        });
        state.running = null;
        tick.exit = result.code;
        tick.signal = result.signal;
        tick.timed_out = result.timedOut;
        log("run", {
            request: next.request, exit: result.code, signal: result.signal, timed_out: result.timedOut, ms: result.ms,
            ...(result.spawnError ? { error: result.spawnError } : {}),
        });
        return tick;
    }
    catch (err) {
        tick.outcome = err instanceof SignInNeeded ? "not_signed_in" : err instanceof ServerUnavailable ? "unreachable" : "error";
        log("tick", { outcome: tick.outcome, error: errName(err) });
        return tick;
    }
    finally {
        cleanup?.();
        removeRunFiles(files);
        state.last_tick = tick;
        try {
            saveState(paths, state);
        }
        catch { /* status only */ }
        lock.release();
    }
}
/** Brings a tracked folder up to its branch; logs one line (an outcome and a code or commit, never the folder). */
async function updateFolder(folder, track, git, log) {
    let r;
    try {
        r = await updateTracked(git, folder, parseTrack(track));
    }
    catch {
        r = { outcome: "fetch_failed", code: "error" };
    }
    if (r.outcome === "updated")
        log({ outcome: "updated", commit: r.commit });
    else if (r.outcome === "dirty")
        log({ outcome: "dirty", reason: "not_checked_out" });
    else if ("code" in r)
        log({ outcome: r.outcome, code: r.code });
    else
        log({ outcome: r.outcome });
    return r;
}
/**
 * While a run (or a tracked folder's update) is going, SIGTERM, SIGINT and SIGHUP (launchd unloading the job, or Ctrl-C)
 * kill the run's process group and any git call's,
 * delete its files and let the lock go before the tick exits. Returns the function that removes the handlers.
 */
function signalCleanup(on, pid, files, lock, note) {
    if (!on)
        return () => { };
    const handler = (signal) => {
        const p = pid();
        if (p !== null)
            killGroup(p, "SIGKILL");
        // A folder's update may be under way: its git calls end with the tick, never outlive the lock.
        killLiveGit();
        removeRunFiles(files);
        note();
        lock.release();
        process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
    };
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    for (const s of signals)
        process.once(s, handler);
    return () => {
        for (const s of signals)
            process.removeListener(s, handler);
    };
}
