// The job's log: one line per tick and one per run's exit. Never a prompt, an entry's text, a note, a token or a
// folder. Each value must look like a word, a number or an id; anything else is written as "?", so a mistake at a
// call site still logs nothing of what it was given.
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
const SAFE = /^[A-Za-z0-9_.:-]{0,64}$/;
const KEY = /^[a-z_]{1,24}$/;
export function formatLine(event, fields = {}, now = new Date()) {
    const parts = [now.toISOString(), SAFE.test(event) ? event : "?"];
    for (const [k, v] of Object.entries(fields)) {
        if (!KEY.test(k))
            continue;
        let shown;
        if (v === null)
            shown = "-";
        else if (typeof v === "number")
            shown = Number.isFinite(v) ? String(Math.round(v)) : "?";
        else if (typeof v === "boolean")
            shown = v ? "yes" : "no";
        else
            shown = SAFE.test(v) ? v : "?";
        parts.push(`${k}=${shown}`);
    }
    return parts.join(" ");
}
export function logLine(path, event, fields = {}) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, formatLine(event, fields) + "\n", { mode: 0o600 });
        chmodSync(path, 0o600);
    }
    catch {
        // A log that cannot be written never stops a tick.
    }
}
/** An error as a log value: its name only, never its message (a message can carry a server's text). */
export const errName = (err) => (err instanceof Error ? err.name : "error");
