// Setups made before the plugin (PDM-55 WU-09). When setup runs from the Product Map plugin it looks for what an
// earlier, local setup left that now sits beside the plugin's own: skills with the plugin's names, a `product-map` MCP
// server added by hand, and a background job running the inbox from somewhere other than its own copy (a repo
// checkout). It lists them (`setup --plan --json`, `legacy`) and, with `--yes`, retires or keeps each one as the
// person answered; it never chooses for them.
//
// Retiring moves the item into ~/.product-map-inbox/retired/<YYYY-MM-DD>/, keeping its path under the home folder,
// and never deletes it. An MCP server is not moved: Claude Code rewrites ~/.claude.json while it runs, so setup never
// edits that file (or a project's .mcp.json). It saves the server's entry as JSON in the backup folder and has
// Claude Code remove it (`claude mcp remove --scope <scope> product-map`). Only items with the plugin's names are
// ever candidates, and nothing else in a project folder is touched.
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePrivateJson } from "./files.js";
import { realLaunchctl } from "./job.js";
import { LABEL } from "./paths.js";
/** The plugin's skills, by name: `/product-map:<name>`. scripts/lib/plugin.test.ts holds this equal to the plugin's. */
export const PLUGIN_SKILLS = ["capture", "draft-brief", "draft-plan", "work-on", "work-unit", "agent-inbox"];
/** The plugin's MCP server's name. One added by hand under the same name gives `mcp__product-map__…` tools beside it. */
export const MCP_NAME = "product-map";
/**
 * Every id setup can give an item, and so every id `--retire` and `--keep` accept: letters, digits, colons and
 * hyphens only, so an id is safe in a shell command in single quotes.
 */
export const LEGACY_ID = /^(?:skill:(?:user|project):(?:capture|draft-brief|draft-plan|work-on|work-unit|agent-inbox)|mcp:(?:user|local|project):product-map|job:repo)$/;
const isLink = (p) => {
    try {
        return lstatSync(p).isSymbolicLink();
    }
    catch {
        return false;
    }
};
const lexists = (p) => {
    try {
        lstatSync(p);
        return true;
    }
    catch {
        return false;
    }
};
const realOr = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return resolve(p);
    }
};
const readJsonQuiet = (p) => {
    try {
        const v = JSON.parse(readFileSync(p, "utf8"));
        return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
    }
    catch {
        return null;
    }
};
const serverIn = (o) => {
    const servers = typeof o === "object" && o !== null ? o.mcpServers : undefined;
    return typeof servers === "object" && servers !== null && Object.hasOwn(servers, MCP_NAME) ? servers[MCP_NAME] : undefined;
};
/** The program the installed job runs (the second ProgramArguments string), or null when there is no job or none. */
export function jobProgram(paths) {
    let xml;
    try {
        xml = readFileSync(paths.plist, "utf8");
    }
    catch {
        return null;
    }
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
    if (!args)
        return null;
    const strings = [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
    return strings[1] ?? null;
}
/** The job's own copy of the inbox: what the job should run. */
export const stableProgram = (paths) => join(paths.appDir, "dist", "cli.js");
/** A `.claude.json` project key for this folder: as given, or its real path, whichever the file holds. */
function localServer(claudeJson, cwd) {
    const projects = claudeJson?.projects;
    if (typeof projects !== "object" || projects === null)
        return undefined;
    for (const key of new Set([cwd, realOr(cwd)])) {
        if (Object.hasOwn(projects, key)) {
            const found = serverIn(projects[key]);
            if (found !== undefined)
                return found;
        }
    }
    return undefined;
}
/**
 * What a setup made before the plugin left here: skills with the plugin's names in ~/.claude/skills and in this
 * folder's .claude/skills, a `product-map` MCP server in ~/.claude.json (user, or local to this folder) or in this
 * folder's .mcp.json, and a job running the inbox from anywhere but its own copy (macOS). Reads only.
 */
export function findLegacy(paths, cwd, opts = {}) {
    const items = [];
    // The folder setup runs in is the person's, and its name reaches the JSON and the questions: by its real path,
    // and only when that path holds no control or direction character (then its items are not candidates at all).
    const realCwd = realOr(cwd);
    const cwdClean = oneLine(realCwd) === realCwd;
    const projectSkills = join(realCwd, ".claude", "skills");
    // A .claude or .claude/skills that is a symlink could point anywhere (another person's folder, ~/.ssh): its
    // skills are not candidates, so setup never moves what such a link reaches.
    const linked = isLink(join(realCwd, ".claude")) || isLink(projectSkills);
    const projectOk = cwdClean && !linked && realOr(projectSkills) !== realOr(paths.userSkills);
    for (const name of PLUGIN_SKILLS) {
        const competes = `/${name} and the plugin's /product-map:${name} would both be offered, and may say different things.`;
        const user = join(paths.userSkills, name);
        if (lexists(user)) {
            items.push({
                id: `skill:user:${name}`, kind: "skill", scope: "user", name, path: user, competes,
                description: name === "agent-inbox"
                    ? "The agent-inbox skill an earlier setup copied into your own skills. The plugin now carries it."
                    : `A ${name} skill in your own skills, from before the plugin.`,
            });
        }
        const project = join(projectSkills, name);
        if (projectOk && lexists(project) && realOr(dirname(project)) === projectSkills) {
            items.push({ id: `skill:project:${name}`, kind: "skill", scope: "project", name, path: project, competes, description: `A ${name} skill in this folder's .claude/skills.` });
        }
    }
    const competesMcp = "Its tools (mcp__product-map__…) would sit beside the plugin's, with a sign-in of their own.";
    const claudeJson = readJsonQuiet(paths.claudeJson);
    if (serverIn(claudeJson) !== undefined) {
        items.push({ id: "mcp:user:product-map", kind: "mcp", scope: "user", name: MCP_NAME, path: paths.claudeJson, competes: competesMcp,
            description: "A product-map server added by hand for every folder (user scope)." });
    }
    if (cwdClean && localServer(claudeJson, cwd) !== undefined) {
        items.push({ id: "mcp:local:product-map", kind: "mcp", scope: "local", name: MCP_NAME, path: paths.claudeJson, competes: competesMcp,
            description: `A product-map server added by hand for this folder only (local scope, ${realCwd}).` });
    }
    const mcpJson = join(realCwd, ".mcp.json");
    if (cwdClean && serverIn(readJsonQuiet(mcpJson)) !== undefined) {
        items.push({ id: "mcp:project:product-map", kind: "mcp", scope: "project", name: MCP_NAME, path: mcpJson, competes: competesMcp,
            description: "A product-map server in this folder's .mcp.json (project scope)." });
    }
    if ((opts.platform ?? process.platform) === "darwin") {
        const program = jobProgram(paths);
        if (program && resolve(program) !== stableProgram(paths)) {
            const from = oneLine(program.endsWith(`${sep}dist${sep}cli.js`) ? dirname(dirname(program)) : program);
            items.push({ id: "job:repo", kind: "job", scope: null, name: LABEL, path: from,
                description: `The background job runs the inbox from ${from}, not from the inbox's own copy.`,
                competes: "The job keeps running that inbox, not the one this plugin carries." });
        }
    }
    return items;
}
/** The entry for this item's MCP server, as it is in its file now; undefined when it is gone. */
function mcpEntry(paths, item, cwd) {
    if (item.scope === "user")
        return serverIn(readJsonQuiet(paths.claudeJson));
    if (item.scope === "local")
        return localServer(readJsonQuiet(paths.claudeJson), cwd);
    return serverIn(readJsonQuiet(join(cwd, ".mcp.json")));
}
const SECRET_KEY = /authori[sz]ation|token|secret|key|password|passw|pwd|cookie|bearer|credential|auth/i;
const REDACTED = "<redacted>";
/** A URL with no credential in it: scheme, host, port and path only (no user, password, query or fragment). */
function redactUrl(u) {
    if (typeof u !== "string")
        return REDACTED;
    try {
        const x = new URL(u);
        return `${x.protocol}//${x.host}${x.pathname}`;
    }
    catch {
        return REDACTED;
    }
}
/**
 * A server's entry with its secrets taken out, for the backup. `type` and `command` are kept; `url` keeps only its
 * scheme, host, port and path; every element of `args` and every value under `headers` and `env` (any case) is
 * redacted; so is any value whose key names a credential (`SECRET_KEY`). Other strings are kept. The backup says how
 * the server was set up, so it could be added again with a fresh sign-in; it never keeps a credential.
 */
export function redactEntry(v) {
    if (Array.isArray(v))
        return v.map(redactEntry);
    if (typeof v !== "object" || v === null)
        return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        const lk = k.toLowerCase();
        if (lk === "type" || lk === "command")
            out[k] = typeof val === "string" ? val : REDACTED;
        else if (lk === "url")
            out[k] = redactUrl(val);
        else if (lk === "args")
            out[k] = Array.isArray(val) ? val.map(() => REDACTED) : REDACTED;
        else if (lk === "headers" || lk === "env") {
            out[k] = typeof val === "object" && val !== null && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).map((h) => [h, REDACTED])) : REDACTED;
        }
        else if (SECRET_KEY.test(k))
            out[k] = REDACTED;
        else
            out[k] = redactEntry(val);
    }
    return out;
}
export const realClaudeRun = (claude, env) => (args, cwd) => {
    const r = spawnSync(claude, args, { cwd, env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.error ? 1 : r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
};
/** The day's backup folder: ~/.product-map-inbox/retired/YYYY-MM-DD (the local date). */
export function retiredDay(paths, now) {
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    return join(paths.retiredDir, d);
}
/** Where `src` goes in the day's folder: its path under the home folder, or under `outside-home/` for one outside it. */
function backupPath(paths, day, src) {
    const rel = relative(paths.home, src);
    const under = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : join("outside-home", resolve(src).replace(/^[/\\]+/, ""));
    return join(day, under);
}
/** `dest`, or `dest-2`, `dest-3`… when it is taken: a backup never replaces another. */
function freeName(dest, ext = "") {
    const base = ext && dest.endsWith(ext) ? dest.slice(0, -ext.length) : dest;
    if (!lexists(dest))
        return dest;
    for (let i = 2; i < 1000; i++) {
        const d = `${base}-${i}${ext}`;
        if (!lexists(d))
            return d;
    }
    throw new Error(`There are too many backups at ${dest}.`);
}
/** Moves a file or folder, across disks too (copied, then removed). Symlinks are moved as links. */
function move(src, dest) {
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    try {
        renameSync(src, dest);
    }
    catch (err) {
        if (err.code !== "EXDEV")
            throw err;
        cpSync(src, dest, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        rmSync(src, { recursive: true, force: true });
    }
}
/**
 * For a job retired in the run that installs the new one: a copy of its plist in the day's backup folder, made before
 * the new job replaces it (so a failed install can put the old one back). Returns where it went.
 */
export function backupJobPlist(paths, now) {
    const dest = freeName(backupPath(paths, retiredDay(paths, now), paths.plist), ".plist");
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    cpSync(paths.plist, dest);
    return dest;
}
const oneLine = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 300);
/** Retires one item into the day's backup folder. Never deletes: a skill or the job's plist is moved, a server's entry saved. */
export function retireItem(paths, item, cwd, deps) {
    const day = retiredDay(paths, (deps.now ?? (() => new Date()))());
    if (item.kind === "skill") {
        if (!lexists(item.path))
            return { ok: true, message: `${item.path} is gone already.` };
        // Checked again right before the move: the folder may have changed since it was listed.
        const skillsDir = item.scope === "user" ? paths.userSkills : join(realOr(cwd), ".claude", "skills");
        const linked = item.scope === "project" && (isLink(join(realOr(cwd), ".claude")) || isLink(skillsDir));
        if (linked || realOr(dirname(item.path)) !== realOr(skillsDir) || (item.scope === "project" && realOr(dirname(item.path)) !== skillsDir)) {
            return { ok: false, message: `${item.path} was not retired: its folder is not the .claude/skills it was found in (a symlink, or it moved). Nothing was moved.` };
        }
        const dest = freeName(backupPath(paths, day, item.path));
        move(item.path, dest);
        return { ok: true, message: `retired ${item.path}: moved to ${dest}.` };
    }
    if (item.kind === "job") {
        if (!lexists(paths.plist))
            return { ok: true, message: "The job is gone already." };
        const launchctl = deps.launchctl ?? realLaunchctl;
        const uid = deps.uid ?? process.getuid?.() ?? 0;
        launchctl(["bootout", `gui/${uid}`, paths.plist]);
        const dest = freeName(backupPath(paths, day, paths.plist), ".plist");
        move(paths.plist, dest);
        return { ok: true, message: `retired the job that ran the inbox from ${item.path}: it was stopped and its plist moved to ${dest}. Nothing in ${item.path} was changed. No project has the inbox on in this run, so no new job was installed: run setup again with the inbox on to have one.` };
    }
    // An MCP server: saved, then removed by Claude Code, which owns the file.
    if (!deps.claude)
        return { ok: false, message: CLAUDE_NEEDED(item) };
    const entry = mcpEntry(paths, item, cwd);
    if (entry === undefined)
        return { ok: true, message: `The product-map server (${item.scope} scope) is gone already.` };
    const saved = freeName(join(day, "mcp", `product-map.${item.scope}.json`), ".json");
    // Saved without its secrets (redactEntry), and still private (mode 600).
    writePrivateJson(saved, { name: MCP_NAME, scope: item.scope, from: item.path, folder: item.scope === "user" ? null : realOr(cwd), config: redactEntry(entry) });
    const r = deps.claude(["mcp", "remove", "--scope", item.scope, MCP_NAME], cwd);
    if (r.code !== 0) {
        return { ok: false, message: `Claude Code did not remove the product-map server (${item.scope} scope): ${oneLine(r.out) || `exit ${r.code}`}. Its entry was saved without its secrets to ${saved}; nothing else was changed. Remove it yourself with: claude mcp remove --scope ${item.scope} ${MCP_NAME}` };
    }
    return { ok: true, message: `retired the product-map server added by hand (${item.scope} scope): Claude Code removed it, and its entry was saved without its secrets to ${saved}.` };
}
export const CLAUDE_NEEDED = (item) => `Claude Code (claude) was not found, so setup cannot remove the product-map server (${item.scope} scope): it never edits Claude Code's settings itself. Install Claude Code where setup can find it, or keep it with --keep '${item.id}', or remove it yourself with: claude mcp remove --scope ${item.scope} ${MCP_NAME}`;
/** What keeping an item means, said once. */
export const keptMessage = (item) => `kept ${item.kind === "job" ? `the job running the inbox from ${item.path}` : item.path}. ${item.competes}`;
