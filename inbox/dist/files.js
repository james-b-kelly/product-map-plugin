// Private files: the directory is 700 and each file 600, written under umask 077 to a fresh temp file (opened with
// O_EXCL, so nothing already there is reused or followed) and swapped in by rename, so a reader never sees half a
// file and nobody else on the machine can read a token. A config directory that is a symlink is refused.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
export function ensurePrivateDir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error(`${dir} is a symlink or not a folder. Remove it and try again.`);
    chmodSync(dir, 0o700);
}
export function writePrivate(path, text) {
    ensurePrivateDir(dirname(path));
    const old = process.umask(0o077);
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        const fd = openSync(tmp, "wx", 0o600);
        try {
            writeSync(fd, text);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, path);
    }
    catch (err) {
        rmSync(tmp, { force: true });
        throw err;
    }
    finally {
        process.umask(old);
    }
}
export function writePrivateJson(path, value) {
    writePrivate(path, JSON.stringify(value, null, 2) + "\n");
}
/** The parsed file, or null when it is missing. A file that is not JSON is an error that names the file. */
export function readJson(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`${path} is not valid JSON. Fix or delete it, then try again.`);
    }
}
/** True when the file can be read or written by anyone but its owner (looser than 600). */
export function looserThanPrivate(path) {
    try {
        return (statSync(path).mode & 0o077) !== 0;
    }
    catch {
        return false;
    }
}
