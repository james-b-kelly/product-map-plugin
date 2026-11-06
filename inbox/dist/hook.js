// The run's PreToolUse hook (passed with `--settings`): a run may touch only its own request, and read only the
// linked folder's code. Arguments: the request's project, its item's kind and name (PDM-99 WU-05: an entry, a brief, a
// plan or a unit), the request id, preset ("-" for none), the thread of a request from @agent ("-" for none), whether
// a brief is published ("published" or "-"), the folder, and "web" when web access is on. Claude Code sends the tool
// call as JSON on stdin; the hook answers with a deny decision, or nothing (the call then goes on to the run's allow list).
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
// A copy of parseItem in supabase/functions/mcp/itemNames.ts (the server names a request's item the same way):
// src/data/itemNamesCopy.test.ts holds them equal. Change both. An entry's prefix is upper case and a slug lower
// case, so a name is read one way only; anything else is not run.
const ENTRY = "[A-Z][A-Z0-9]{1,4}-[1-9][0-9]{0,8}";
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PLAN = "[1-9][0-9]{0,8}";
const WU = "WU-(0[1-9]|[1-9][0-9]{1,8})";
const ENTRY_NAME = new RegExp(`^${ENTRY}$`);
const BRIEF_NAME = new RegExp(`^${SLUG}$`);
const ENTRY_PLAN = new RegExp(`^(${ENTRY}) P(${PLAN})$`);
const BRIEF_PLAN = new RegExp(`^(${SLUG}) plan$`);
const ENTRY_UNIT = new RegExp(`^(${ENTRY})(?: P(${PLAN}))? ${WU}$`);
const BRIEF_UNIT = new RegExp(`^(${SLUG}) ${WU}$`);
const MAX_SLUG = 60;
export function parseItem(kind, name) {
    if (typeof name !== "string" || name.length > 100)
        return null;
    let m;
    switch (kind) {
        case "entry":
            return ENTRY_NAME.test(name) ? { kind, name, slug: name } : null;
        case "brief":
            return BRIEF_NAME.test(name) && name.length <= MAX_SLUG ? { kind, name, slug: name } : null;
        case "plan":
            if ((m = ENTRY_PLAN.exec(name)))
                return { kind, name, slug: m[1], of: "entry", plan: Number(m[2]) };
            if ((m = BRIEF_PLAN.exec(name)) && m[1].length <= MAX_SLUG)
                return { kind, name, slug: m[1] };
            return null;
        case "unit":
            if ((m = ENTRY_UNIT.exec(name)))
                return { kind, name, slug: m[1], of: "entry", plan: m[2] ? Number(m[2]) : 0, unit: Number(m[3]) };
            if ((m = BRIEF_UNIT.exec(name)) && m[1].length <= MAX_SLUG)
                return { kind, name, slug: m[1], unit: Number(m[2]) };
            return null;
        default:
            return null;
    }
}
/** How a run's words name its item: "the entry PDB-7", "the brief some-brief", "the plan of the brief some-brief", "the work unit PDB-7 P2 WU-03". */
export function itemWords(item) {
    if (item.kind === "plan" && item.of === undefined)
        return `the plan of the brief ${item.slug}`;
    return `the ${item.kind === "unit" ? "work unit" : item.kind} ${item.name}`;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The web tools a run has only when the person turned web access on (`web on`). */
export const WEB_TOOLS = ["WebFetch", "WebSearch"];
const PREFIX = "mcp__product-map__";
/**
 * The tools every run may call. The plan tools are for any request, not only preset 4: the prompt is free text, and
 * they reach only the request's entry's plans and units, or its published brief's plan and units (PDM-99 WU-05; never
 * on a plan's or a unit's request), which the person still approves or releases. No list_agent_requests
 * or list_projects: they answer about every project, and a run needs only its own request.
 */
export const BASE_TOOLS = [
    "get_map", "list_work", "read_doc",
    "take_agent_request", "finish_agent_request",
    "comment", "write_doc",
];
// No approve_plan (PDM-55 WU-07) and no release_units (PDM-98 WU-01): they act on the person's word, which a run never has.
// No set_entry_part (PDM-97 WU-01): a run makes no brief, so it never needs a part, and an entry's text must not be able to move entries on the map.
// No edit_unit: it changes a released or started unit too (title, branch, PR, dependencies), and a run steered by an
// entry's text could use it on any unit of the entry. A run adds units and writes their text; it never edits them.
// PDM-99 WU-05: not even on a unit's own request (@agent in a unit's thread): a request to change a unit is answered
// with a reply saying exactly what to change, for a person to make.
// No set_brief_dependencies (Dependencies WU-04): it makes a whole brief wait, which is the person's to decide; a run
// says so in its comment. create_unit's depends_on is not looked into: it may name units in other plans and briefs of
// the project, and it can only make the run's own new unit wait, never start or change the units it names.
export const PLAN_TOOLS = ["create_plan", "create_unit", "request_confirmation"];
export const RUN_TOOLS = [...BASE_TOOLS, ...PLAN_TOOLS];
/** ASCII lower case only: no Unicode case folding, so no other character can stand in for one of the id's. */
const asciiLower = (v) => v.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const sameEntry = (a, entry) => typeof a === "string" && asciiLower(a) === asciiLower(entry);
/** The entry itself (kind entry, no `of`), or its own plan or a unit of it (kind plan or unit, `of: entry`). */
function entryDoc(input, entry) {
    const own = (input.kind === "entry" && !("of" in input)) || ((input.kind === "plan" || input.kind === "unit") && input.of === "entry");
    return own && sameEntry(input.slug, entry);
}
/** The entry's own plan or units, for the plan tools (which take no kind). */
const entryPlan = (input, entry) => !("kind" in input) && input.of === "entry" && sameEntry(input.slug, entry);
/** A brief's own plan or units, for the plan tools: its slug, exactly, with no kind and no `of`. */
const briefPlan = (input, slug) => !("kind" in input) && !("of" in input) && input.slug === slug;
/**
 * `plan` as the tools take it, a number or "P2" / "2", equal to this plan's number. Left out never matches. It reads
 * a value exactly as the server's `planArg` (supabase/functions/mcp/tools.ts) does, or not at all (no trimming), so a
 * value it lets through names the plan the server will use: src/data/itemNamesCopy.test.ts holds the two together.
 */
export function samePlan(v, n) {
    if (n === undefined)
        return false;
    if (typeof v === "number")
        return Number.isInteger(v) && v >= 0 && v <= 1_000_000 && v === n;
    const m = typeof v === "string" ? /^[Pp]?([0-9]{1,6})$/.exec(v) : null;
    return m !== null && Number(m[1]) === n;
}
const ofKind = (input, ...kinds) => kinds.includes(input.kind);
/**
 * The documents a run may comment on and append to, by its item (PDM-99 WU-05). An entry: the entry and its own plans
 * and units, as before. A brief: the brief, and its plan and units only when it is published. A plan: the plan and its
 * units. A unit: that unit only. A plan or unit under an entry is named with `of: entry` and its own `plan`, which must
 * be given: left out, the server picks a plan the hook cannot see.
 */
function covers(input, s) {
    const it = s.item;
    const underEntry = input.of === "entry" && sameEntry(input.slug, it.slug);
    const underBrief = !("of" in input) && input.slug === it.slug;
    switch (it.kind) {
        case "entry":
            return entryDoc(input, it.slug);
        case "brief":
            return underBrief && (ofKind(input, "brief") || (s.published === true && ofKind(input, "plan", "unit")));
        case "plan":
            return ofKind(input, "plan", "unit") && (it.of === "entry" ? underEntry && samePlan(input.plan, it.plan) : underBrief);
        case "unit":
            return ofKind(input, "unit") && input.unit === it.unit && (it.of === "entry" ? underEntry && samePlan(input.plan, it.plan) : underBrief);
        default:
            return false;
    }
}
/** Where a run may draft a plan or work units: on an entry, and on a brief that is published. */
const draftsPlans = (s) => s.item.kind === "entry" || (s.item.kind === "brief" && s.published === true);
/** The built-in tools a run has: reading the linked folder's code, never changing it or running anything. */
export const CODE_TOOLS = ["Read", "Grep", "Glob"];
/**
 * Files a run never reads, by name or by a folder on the way to them: secrets and credentials. Claude Code's own
 * deny rules (`readDenyRules`) cover the same names for Grep and Glob, which can reach files without naming them:
 * the hook sees only the path a call names, so a whole-folder search rests on those rules.
 */
const SECRET_NAME = [
    /^\.env/i, /\.env$/i, /^\.envrc$/i, /^\.dev\.vars$/i,
    /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|tfvars|tfstate(\.backup)?)$/i, /keychain/i,
    /^id_(rsa|dsa|ecdsa|ed25519)/i,
    /^\.(npmrc|netrc|pgpass|pypirc|dockercfg|git-credentials|mcp\.json)$/i,
    /^\.?credentials(\.json)?$/i, /service.?account.*\.json$/i, /secret.*\.(json|ya?ml|env|txt|toml)$/i,
    /^settings\.local\.json$/i,
];
const SECRET_DIR = /^(\.git|\.vercel|\.temp|\.ssh|\.aws|\.gnupg|\.config|\.docker|\.supabase|\.superpowers|\.branches|secrets?|\.env.*)$/i;
export function isSecretPath(rel) {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    return parts.some((p, i) => SECRET_DIR.test(p) || (i === parts.length - 1 && SECRET_NAME.some((r) => r.test(p))));
}
/** A path inside the folder (after symlinks), as a path relative to it, or null. */
export function insideFolder(target, folder) {
    // The real path of the nearest part that exists, so a symlink on the way out is followed even to a missing file.
    let real = resolve(target);
    let rest = "";
    for (;;) {
        try {
            real = join(realpathSync(real), rest);
            break;
        }
        catch {
            const up = dirname(real);
            if (up === real)
                break;
            rest = join(basename(real), rest);
            real = up;
        }
    }
    const rel = relative(folder, real);
    if (rel === "")
        return "";
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
        return null;
    return rel;
}
function decideRead(tool, raw, folder) {
    if (!folder)
        return "This run has no linked folder to read.";
    const input = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {});
    const given = tool === "Read" ? input.file_path : input.path;
    if (given !== undefined && typeof given !== "string")
        return "This run may read only the linked folder.";
    // No home folder, variable or NUL: the hook resolves paths itself and would not see what a tool expands them to.
    for (const v of [given, input.pattern, input.glob]) {
        if (typeof v === "string" && (v.startsWith("~") || v.includes("$") || v.includes("\0")))
            return "This run may read only the linked folder.";
    }
    if (tool === "Read" && typeof given !== "string")
        return "Read needs a file in the linked folder.";
    let root = folder;
    try {
        root = realpathSync(folder);
    }
    catch { /* checked as given */ }
    const rel = insideFolder(resolve(root, given ?? "."), root);
    if (rel === null)
        return "This run may read only the linked folder.";
    if (isSecretPath(rel))
        return "This run may not read that file: it may hold secrets.";
    // A Glob pattern or a Grep glob that climbs out of the folder, or names a secret file, is refused the same way.
    for (const key of ["pattern", "glob"]) {
        if (tool === "Grep" && key === "pattern")
            continue;
        const v = input[key];
        if (typeof v !== "string")
            continue;
        if (v.includes("..") || isAbsolute(v))
            return "This run may read only the linked folder.";
        // A character class can spell a secret name the checks below would not see (`.e[n]v`).
        if (v.includes("["))
            return "This run may not use character classes in a file pattern.";
        // Braces and classes stripped, each piece is checked as a path: `{src,.git}/**` names .git.
        const pieces = v.replace(/[{}\[\]]/g, ",").split(",").map((x) => x.replace(/\*+/g, "x")).filter(Boolean);
        if (pieces.some((x) => isSecretPath(x)) || /(^|[\\/,{])\.env/i.test(v) || /\.env([,}]|$)/i.test(v))
            return "This run may not read that file: it may hold secrets.";
    }
    return null;
}
/**
 * Claude Code's own deny rules for the same secret files, so Grep and Glob skip them too. The `**` rules match under
 * the run's folder; `home` adds the person's own credential files by full path, behind the hook's folder check.
 */
export const readDenyRules = (home = "") => ["**/.env", "**/.env*", "**/*.env", "**/.env*/**", "**/.envrc", "**/.dev.vars",
    "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.keystore", "**/*.tfvars", "**/*.tfstate", "**/*.tfstate.backup",
    "**/id_rsa*", "**/id_dsa*", "**/id_ecdsa*", "**/id_ed25519*",
    "**/.npmrc", "**/.netrc", "**/.pgpass", "**/.pypirc", "**/.git-credentials", "**/.mcp.json", "**/credentials", "**/credentials.json",
    "**/*service*account*.json", "**/*secret*.json", "**/*secret*.yml", "**/*secret*.yaml", "**/*secret*.env", "**/*secret*.txt", "**/*secret*.toml",
    "**/settings.local.json",
    "**/.git/**", "**/.vercel/**", "**/.temp/**", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/.config/**", "**/.docker/**", "**/.supabase/**",
    "**/secret/**", "**/secrets/**", "**/.superpowers/**", "**/.branches/**",
    "**/.credentials.json", "**/.dockercfg", "**/*.p8", "**/*.kdbx", "**/*keychain*"]
    .map((p) => `Read(${p})`)
    .concat(home ? [".config/**", ".claude/**", ".claude.json", ".ssh/**", ".aws/**", ".gnupg/**", ".docker/**", ".zsh_history", ".bash_history", ".zshrc", ".gitconfig", ".npmrc", ".netrc", "Library/**"]
    .map((p) => `Read(/${home.replace(/\/+$/, "")}/${p})`) : []);
/**
 * Whether a URL names this Mac or a local network: localhost, a .local name, or a loopback, private, link-local or
 * unspecified address (IPv4, or IPv6 in brackets). Not a URL at all counts too. A public name that resolves to a
 * private address is not caught.
 */
export function localUrl(url) {
    let host;
    try {
        host = new URL(String(url)).hostname.toLowerCase();
    }
    catch {
        return true;
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "")
        return true;
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host.startsWith("[")) {
        const v6 = host.slice(1, -1);
        return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
    }
    return false;
}
/** null to let the call go on, or the reason it is refused. */
export function decide(call, scope) {
    const name = typeof call.tool_name === "string" ? call.tool_name : "";
    if (CODE_TOOLS.includes(name))
        return decideRead(name, call.tool_input, scope.folder);
    if (WEB_TOOLS.includes(name)) {
        // A run an @agent message started answers text anyone in the project could write, so it never has the web, even
        // when the Mac has it on (PDM-109): that text could have it put project content in a URL. run.ts leaves the web
        // tools out of such a run too; this is the second guard.
        if (scope.thread)
            return "This run was started by an @agent message, so it may not use the web.";
        if (!scope.web)
            return "Web access is off on this Mac (npx product-map-inbox web on).";
        const url = call.tool_input?.url;
        return name === "WebFetch" && localUrl(url) ? "This run may not open addresses on this Mac or its local network." : null;
    }
    if (!name.startsWith(PREFIX))
        return "This run may use only the Product Map tools and read the linked folder.";
    const tool = name.slice(PREFIX.length);
    if (!RUN_TOOLS.includes(tool))
        return `This run may not use ${tool}.`;
    const input = (typeof call.tool_input === "object" && call.tool_input !== null && !Array.isArray(call.tool_input) ? call.tool_input : {});
    const what = itemWords(scope.item);
    const onlyItem = `This run may write only to ${what}.`;
    if (tool === "take_agent_request" || tool === "finish_agent_request") {
        return input.request === scope.request ? null : "This run works only on its own request.";
    }
    // Every other tool names a project, and it must be the request's, exactly.
    if (input.project !== scope.project)
        return `This run works only in ${scope.project}.`;
    switch (tool) {
        case "get_map":
        case "list_work":
        case "read_doc":
            // Reads of other documents in the same project are allowed: they are background.
            return null;
        case "comment":
            if (!covers(input, scope))
                return onlyItem;
            // PDM-99 WU-05: a request from @agent is answered in the thread that asked, never in a new thread or another one.
            if (scope.thread !== undefined && (typeof input.thread !== "string" || input.thread.toLowerCase() !== scope.thread.toLowerCase())) {
                return `This run answers in the thread that asked: reply with thread ${scope.thread}.`;
            }
            return null;
        case "write_doc":
            if (input.mode !== "append")
                return "This run may only append (mode append).";
            return covers(input, scope) ? null : onlyItem;
        case "create_plan":
        case "create_unit":
            // PDM-55 WU-07: a run prepares work and never builds it, so it never fast-tracks: what it adds stays a draft
            // for the person to release, and a plan waits for their approval. The server refuses the inbox's connection too.
            if ("fast_track" in input)
                return "This run may not use fast_track: the person releases and approves what it prepares.";
            if (!draftsPlans(scope))
                return `This run may not draft a plan or work units on ${what}.`;
            return (scope.item.kind === "entry" ? entryPlan(input, scope.item.slug) : briefPlan(input, scope.item.slug)) ? null : onlyItem;
        case "request_confirmation": {
            if (scope.item.kind === "brief" && scope.published === true) {
                // A published brief's plan: only its approval, which the person confirms.
                const approve = input.action === "approve" && input.kind === "plan" && !("of" in input) && input.slug === scope.item.slug;
                return approve ? null : `This run may only ask the person to approve the plan of ${what}.`;
            }
            if (scope.item.kind !== "entry")
                return `This run may not ask for a confirmation on ${what}.`;
            // Approving the entry's plan, or releasing its draft units (units with no plan): both the person confirms.
            const approve = input.action === "approve" && input.kind === "plan" && input.of === "entry";
            const release = input.action === "release" && input.kind === "entry" && !("of" in input);
            return (approve || release) && sameEntry(input.slug, scope.item.slug)
                ? null : `This run may only ask the person to approve the plan of ${scope.item.slug} or release its draft units.`;
        }
        default:
            return `This run may not use ${tool}.`;
    }
}
/**
 * The hook's arguments, in run.ts's order (hookSettings): project, kind, name, request, preset, thread, published,
 * folder, web. An item that cannot be named, or a thread that is not a uuid, throws: the call is then refused.
 */
export function parseScope(argv) {
    const [project = "", kind = "", name = "", request = "", preset = "-", thread = "-", published = "-", folder = "", web = ""] = argv;
    const item = parseItem(kind, name);
    if (item === null)
        throw new Error("The run's item is malformed.");
    if (thread !== "-" && !UUID.test(thread))
        throw new Error("The run's thread is malformed.");
    const n = Number(preset);
    return {
        project, item, request, preset: Number.isInteger(n) && n >= 1 && n <= 4 ? n : null,
        ...(thread !== "-" ? { thread } : {}), ...(published === "published" ? { published: true } : {}),
        ...(folder ? { folder } : {}), ...(web === "web" ? { web: true } : {}),
    };
}
export function answer(reason) {
    if (reason === null)
        return "";
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}
function main() {
    let call = {};
    try {
        call = JSON.parse(readFileSync(0, "utf8"));
    }
    catch {
        call = {};
    }
    let reason;
    try {
        reason = decide(call, parseScope(process.argv.slice(2)));
    }
    catch {
        reason = "The run's guard failed.";
    }
    const out = answer(reason);
    if (out)
        process.stdout.write(out);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main();
