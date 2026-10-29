// `wait` (PDM-63 WU-03): says what a work unit is waiting on, for the Product Map plugin's hooks. A Claude Code hook
// cannot use the MCP sign-in Claude Code holds, so it calls this, which uses this machine's sign-in (setup's): another
// agent client of the same person, which Product Map accepts for a wait in the session that holds the unit
// (private.holds_session). Quiet: nothing on stdout, a short reason on stderr, and the exit code says how it went.
import { freshAuth } from "./auth.js";
import { McpClient, PROJECT_PATTERN } from "./mcp.js";
/** The kinds, as the server's set_waiting takes them (supabase/functions/mcp/waiting.ts), and none to clear. */
export const WAIT_KINDS = ["permission", "answer", "merge", "confirm", "check_by_hand", "hand_action", "check", "other_unit", "none"];
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_DETAIL = 200;
/** One line of at most 200 characters: control characters and line separators become spaces, then it is cut. */
export function oneLine(v) {
    const d = v.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim();
    if (!d)
        return null;
    const chars = [...d];
    return chars.length <= MAX_DETAIL ? d : chars.slice(0, MAX_DETAIL - 1).join("") + "…";
}
/** The flags, checked; or the reason they cannot be used. */
export function parseWaitArgs(raw) {
    const v = new Map();
    for (let i = 0; i < raw.length; i++) {
        const m = /^--([a-z]+)(?:=(.*))?$/.exec(raw[i]);
        if (!m)
            return { error: `Not a flag: ${raw[i].slice(0, 40)}` };
        v.set(m[1], m[2] ?? raw[++i] ?? "");
    }
    const project = v.get("project") ?? "";
    if (!PROJECT_PATTERN.test(project))
        return { error: "--project is <organisation>/<project>." };
    const of = v.get("of") ?? "brief";
    if (of !== "entry" && of !== "brief")
        return { error: "--of is entry or brief." };
    const slug = v.get("slug") ?? "";
    if (!SLUG.test(slug))
        return { error: "--slug is an entry's id or a brief's slug." };
    const unit = Number(v.get("unit"));
    if (!Number.isInteger(unit) || unit < 1)
        return { error: "--unit is a unit's number." };
    const planRaw = v.get("plan");
    const plan = planRaw === undefined ? null : planRaw.trim() === "" ? NaN : Number(planRaw);
    if (plan !== null && (!Number.isInteger(plan) || plan < 0))
        return { error: "--plan is a plan's number, or 0." };
    const session = v.get("session") ?? "";
    if (!SESSION.test(session))
        return { error: "--session is the session id the unit was picked up with." };
    const kind = v.get("kind") ?? "";
    if (!WAIT_KINDS.includes(kind))
        return { error: `--kind is one of ${WAIT_KINDS.join(", ")}.` };
    const detailRaw = v.get("detail");
    return { project, of, slug, plan, unit, session, kind: kind, detail: detailRaw === undefined ? null : oneLine(detailRaw) };
}
/** set_waiting through this machine's sign-in. True when Product Map took it; a refusal or no sign-in is false. */
export async function sendWait(paths, a, opts = {}) {
    const auth = await freshAuth(paths, { fetch: opts.fetch });
    const client = new McpClient(paths, auth, { fetch: opts.fetch });
    const args = { project: a.project, slug: a.slug, unit: a.unit, kind: a.kind, session: a.session };
    if (a.of === "entry")
        args.of = "entry";
    if (a.plan !== null)
        args.plan = a.plan;
    if (a.detail !== null && a.kind !== "none")
        args.detail = a.detail;
    const r = await client.callTool("set_waiting", args);
    return !r.isError;
}
