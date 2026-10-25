// What the job remembers between ticks: the requests it has already held (so each is held once), its attempts at
// each request (to back off and give up on one that never gets answered), the run in flight, and how the last tick
// went, for `status`.
import { readJson, writePrivateJson } from "./files.js";
const empty = () => ({ held: [], attempts: [], running: null, last_tick: null, claude_missing: false, tracks: {}, copies: {} });
function copiesFrom(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return {};
    const out = {};
    for (const [k, c] of Object.entries(v)) {
        // The note is sent to Product Map as a hold: one longer than any the job writes is not taken from the file.
        if (c && typeof c === "object" && typeof c.kind === "string" && typeof c.note === "string" && c.note.length <= 1000 && typeof c.at === "number") {
            out[k] = { kind: c.kind, note: c.note, at: c.at, ...(typeof c.count === "number" ? { count: c.count } : {}) };
        }
    }
    return out;
}
function tracksFrom(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return {};
    const out = {};
    for (const [k, t] of Object.entries(v)) {
        if (t && typeof t === "object" && typeof t.outcome === "string" && typeof t.at === "string" && typeof t.since === "string") {
            out[k] = { outcome: t.outcome, at: t.at, since: t.since, commit: typeof t.commit === "string" ? t.commit : null };
        }
    }
    return out;
}
/** Records a tracked folder's update outcome, keeping `since` while the outcome stays the same. */
export function noteTrack(state, project, outcome, commit, at) {
    const prev = state.tracks[project];
    state.tracks[project] = { outcome, at, since: prev && prev.outcome === outcome ? prev.since : at, commit };
}
/** The state; a file that cannot be read starts again empty, and `onError` is told (a tick logs it). */
export function loadState(paths, onError) {
    let s;
    try {
        s = readJson(paths.state);
    }
    catch {
        onError?.("state_unreadable");
        return empty();
    }
    if (!s || typeof s !== "object")
        return empty();
    const attempts = Array.isArray(s.attempts)
        ? s.attempts.filter((a) => typeof a === "object" && a !== null && typeof a.id === "string" && typeof a.count === "number" && typeof a.last_at === "number")
        : [];
    const r = s.running;
    return {
        held: Array.isArray(s.held) ? s.held.filter((x) => typeof x === "string") : [],
        attempts: attempts.map((a) => ({ ...a, project: String(a.project ?? ""), entry: String(a.entry ?? ""), prompt_hash: String(a.prompt_hash ?? ""), gave_up: a.gave_up === true })),
        running: r && typeof r.pid === "number" && typeof r.started_at === "number" && typeof r.session === "string" ? r : null,
        last_tick: s.last_tick ?? null,
        claude_missing: s.claude_missing === true,
        tracks: tracksFrom(s.tracks),
        copies: copiesFrom(s.copies),
    };
}
export const saveState = (paths, state) => writePrivateJson(paths.state, state);
