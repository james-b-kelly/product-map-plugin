// One holder at a time (the tick lock, and the refresh lock). A lock is published whole: its pid and start time are
// written to a temp file first, which is then hard-linked to the lock's name (link fails if the name exists), so no
// reader ever sees an empty lock. A lock whose process is gone, or older than its stale limit, is taken over by
// renaming it aside atomically and checking that what was renamed is what was judged stale.
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./files.js";
/** A run is killed at 15 minutes; a tick lock older than 20 is left by a tick that died without removing it. */
export const STALE_MS = 20 * 60_000;
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
};
const unique = (path, what) => `${path}.${what}.${process.pid}.${randomBytes(6).toString("hex")}`;
function readHeld(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    try {
        const v = JSON.parse(raw);
        return { pid: typeof v.pid === "number" ? v.pid : null, at: typeof v.at === "number" ? v.at : 0, raw };
    }
    catch {
        return { pid: null, at: 0, raw };
    }
}
function tryCreate(path, now) {
    const body = JSON.stringify({ pid: process.pid, at: now, nonce: randomBytes(8).toString("hex") });
    const tmp = unique(path, "new");
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeSync(fd, body);
    }
    finally {
        closeSync(fd);
    }
    try {
        linkSync(tmp, path);
    }
    catch (err) {
        if (err.code === "EEXIST")
            return null;
        throw err;
    }
    finally {
        rmSync(tmp, { force: true });
    }
    let released = false;
    return {
        release: () => {
            if (released)
                return;
            released = true;
            // Only our own lock is removed: a stale-lock takeover by another process must not be undone.
            const held = readHeld(path);
            if (held?.raw === body)
                rmSync(path, { force: true });
        },
    };
}
/** The lock, or null when another live holder has it. */
export function takeLock(path, opts = {}) {
    const now = (opts.now ?? Date.now)();
    ensurePrivateDir(dirname(path));
    const got = tryCreate(path, now);
    if (got)
        return got;
    const held = readHeld(path);
    if (held === null)
        return tryCreate(path, now); // let go in between
    const isAlive = opts.isAlive ?? alive;
    const stale = held.pid === null || !isAlive(held.pid) || now - held.at > (opts.staleMs ?? STALE_MS);
    if (!stale)
        return null;
    // Take it aside atomically, then make sure it was the lock judged stale and not a fresh one made since the read.
    const aside = unique(path, "stale");
    try {
        renameSync(path, aside);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return tryCreate(path, now);
        throw err;
    }
    let moved = "";
    try {
        moved = readFileSync(aside, "utf8");
    }
    catch {
        moved = "";
    }
    if (moved !== held.raw) {
        // Someone else's fresh lock: put it back (link fails only if yet another lock exists, which then stands).
        try {
            linkSync(aside, path);
        }
        catch { /* another lock stands */ }
        rmSync(aside, { force: true });
        return null;
    }
    rmSync(aside, { force: true });
    return tryCreate(path, now);
}
/** Whether a live holder has the lock now (for `status`, which must not refresh during a tick). */
export function lockHeld(path, isAlive = alive, staleMs = STALE_MS, now = Date.now()) {
    const held = readHeld(path);
    return held !== null && held.pid !== null && isAlive(held.pid) && now - held.at <= staleMs;
}
