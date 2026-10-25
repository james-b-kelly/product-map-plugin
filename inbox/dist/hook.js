// The run's PreToolUse hook (passed with `--settings`): a run may touch only its own request, and read only the
// linked folder's code. Arguments: the request's project, entry id, request id, preset ("-" for none) and folder. Claude Code sends the tool call as JSON on
// stdin; the hook answers with a deny decision, or nothing (the call then goes on to the run's allow list).
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
/** The web tools a run has only when the person turned web access on (`web on`). */
export const WEB_TOOLS = ["WebFetch", "WebSearch"];
const PREFIX = "mcp__product-map__";
/**
 * The tools every run may call. The plan tools are for any request, not only preset 4: the prompt is free text, and
 * they reach only this entry's plan and units, which the person still approves or releases. No list_agent_requests
 * or list_projects: they answer about every project, and a run needs only its own request.
 */
export const BASE_TOOLS = [
    "get_map", "list_work", "read_doc",
    "take_agent_request", "finish_agent_request",
    "comment", "write_doc",
];
// No approve_plan (PDM-55 WU-07): it approves on the person's word, which a run never has.
// No edit_unit: it changes a released or started unit too (title, branch, PR, dependencies), and a run steered by an
// entry's text could use it on any unit of the entry. A run adds units and writes their text; it never edits them.
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
    const onlyEntry = `This run may write only to the entry ${scope.entry}.`;
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
            return entryDoc(input, scope.entry) ? null : onlyEntry;
        case "write_doc":
            if (input.mode !== "append")
                return "This run may only append (mode append).";
            return entryDoc(input, scope.entry) ? null : onlyEntry;
        case "create_plan":
        case "create_unit":
            // PDM-55 WU-07: a run prepares work and never builds it, so it never fast-tracks: what it adds stays a draft
            // for the person to release, and a plan waits for their approval. The server refuses the inbox's connection too.
            if ("fast_track" in input)
                return "This run may not use fast_track: the person releases and approves what it prepares.";
            return entryPlan(input, scope.entry) ? null : onlyEntry;
        case "request_confirmation": {
            // Approving the entry's plan, or releasing its draft units (units with no plan): both the person confirms.
            const approve = input.action === "approve" && input.kind === "plan" && input.of === "entry";
            const release = input.action === "release" && input.kind === "entry" && !("of" in input);
            return (approve || release) && sameEntry(input.slug, scope.entry)
                ? null : `This run may only ask the person to approve the plan of ${scope.entry} or release its draft units.`;
        }
        default:
            return `This run may not use ${tool}.`;
    }
}
export function parseScope(argv) {
    const [project = "", entry = "", request = "", preset = "-", folder = "", web = ""] = argv;
    const n = Number(preset);
    return { project, entry, request, preset: Number.isInteger(n) && n >= 1 && n <= 4 ? n : null, ...(folder ? { folder } : {}), ...(web === "web" ? { web: true } : {}) };
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
