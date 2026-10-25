// `setup` (PDM-55 WU-03): in a terminal it asks, and without one (Claude Code's Bash tool) it is driven by flags:
// `--plan` reports what is there and changes nothing, `--yes` does what the flags say and refuses rather than choose.
// Both forms make the same decisions and run the same steps, in two parts:
//
// 1. Always: signed in, the projects, and the person's role in each (`set_contribution`). For Shape that is all:
//    no inbox question, no repo step, no git, no job.
// 2. Build only, and optional: the inbox, a folder for the project's requests (a copy the person names with
//    `--copy`, checked against the project's repo by its origin, or a copy the inbox keeps with `--clone`), then the
//    skill and the background job, installed only when at least one project has the inbox on.
//
// Setup never clones and never picks a folder without an explicit choice, and keeps a folder the person linked
// unless `--replace` says otherwise. Safe to run again: what is right is kept, what drifted (a copy no longer
// following its repo's branch, a job running an old copy of the inbox) is fixed, and each step says what it did.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { freshAuth, loadAuth, login, SignInNeeded } from "./auth.js";
import { ensureCopy, failureMessage, ownerRepo } from "./copies.js";
import { cannotLink, expandFolder, isDirectory, linkFor, linkPlain, linkTracked, loadFolders, notAllowed, projectArg, restoreLink, unlinkLink, unsafeFolder, } from "./folders.js";
import { checkTrack, GIT_TIMEOUT_MS, inFolder, parseTrack, realGit } from "./git.js";
import { checkJob, install, jobPathProblem } from "./job.js";
import { takeLock } from "./lock.js";
import { contributionOf, listProjects, listRepos, McpClient, PROJECT_PATTERN, REPO_NAME, REPO_NAME_MAX, ReposRefused, setContribution, } from "./mcp.js";
import { DEFAULT_SERVER, serverFrom } from "./paths.js";
import { findClaude } from "./run.js";
import { installSkill } from "./skill.js";
const PER_PROJECT = new Set(["--role", "--copy", "--clone", "--repo", "--replace", "--allow-unverified-folder"]);
export const SETUP_USAGE = `setup [--server <url> [--yes-other-server]] [--plan | --yes] [--json] [--no-inbox] [--look <folder>]...
      [--project <org>/<project> [--role shape|build] [--copy <folder> [--allow-unverified-folder] | --clone] [--repo <name>] [--replace]]...
  Flags after a --project apply to that project only.`;
/**
 * The setup flags. Global flags may come anywhere; `--role`, `--copy`, `--clone`, `--repo` and `--replace` apply to
 * the `--project` before them, so `--project acme/easel --role build --clone --project acme/artlogic --role shape`
 * sets up two projects. Throws a plain Error for anything it cannot read.
 */
export function parseSetupArgs(argv) {
    const a = { yesOtherServer: false, plan: false, json: false, yes: false, noInbox: false, look: [], projects: [] };
    let current = null;
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
        const name = eq > 0 ? raw.slice(0, eq) : raw;
        const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
        const value = () => {
            const v = inline ?? argv[++i];
            if (v === undefined || v.trim() === "" || (inline === undefined && v.startsWith("--")))
                throw new Error(`${name} needs a value.`);
            return v;
        };
        const flagOnly = () => {
            if (inline !== undefined)
                throw new Error(`${name} takes no value.`);
        };
        if (PER_PROJECT.has(name) && !current)
            throw new Error(`${name} applies to one project: put it after --project <organisation>/<project>.`);
        const p = current;
        const once = (k) => {
            if (p[k] !== undefined)
                throw new Error(`${name} is given twice for ${p.project}.`);
        };
        switch (name) {
            case "--server":
                a.server = value();
                break;
            case "--yes-other-server":
                flagOnly();
                a.yesOtherServer = true;
                break;
            case "--plan":
                flagOnly();
                a.plan = true;
                break;
            case "--json":
                flagOnly();
                a.json = true;
                break;
            case "--yes":
                flagOnly();
                a.yes = true;
                break;
            case "--no-inbox":
                flagOnly();
                a.noInbox = true;
                break;
            case "--look":
                a.look.push(value());
                break;
            case "--project": {
                const key = projectArg(value());
                if (a.projects.some((x) => x.project.toLowerCase() === key.toLowerCase()))
                    throw new Error(`--project ${key} is given twice.`);
                current = { project: key };
                a.projects.push(current);
                break;
            }
            case "--role": {
                once("role");
                const r = value();
                if (r !== "shape" && r !== "build")
                    throw new Error(`--role is shape or build, not ${r}.`);
                p.role = r;
                break;
            }
            case "--copy":
                once("copy");
                p.copy = value();
                break;
            case "--clone":
                flagOnly();
                p.clone = true;
                break;
            case "--repo": {
                once("repo");
                const r = value();
                // A repo's name as Project settings, Repos holds it: never a path, a flag or anything a shell would read.
                if (!REPO_NAME.test(r) || r.length > REPO_NAME_MAX) {
                    throw new Error(`--repo is a repo's name as Project settings, Repos shows it: lower-case letters, digits and hyphens, at most ${REPO_NAME_MAX} characters.`);
                }
                p.repo = r;
                break;
            }
            case "--replace":
                flagOnly();
                p.replace = true;
                break;
            case "--allow-unverified-folder":
                flagOnly();
                p.allowUnverified = true;
                break;
            default: throw new Error(`setup has no option ${raw}. Usage: npx product-map-inbox ${SETUP_USAGE}`);
        }
    }
    if (a.plan && a.yes)
        throw new Error("Choose one: --plan shows what setup would do, --yes does it.");
    if (a.yesOtherServer && !a.server)
        throw new Error("--yes-other-server goes with --server <url>.");
    if (a.json && !a.plan && !a.yes)
        throw new Error("--json goes with --plan or --yes: the questions need a terminal.");
    for (const p of a.projects) {
        if (p.copy && p.clone)
            throw new Error(`${p.project}: choose --copy <folder> or --clone, not both.`);
        if (p.role === "shape" && (p.copy || p.clone))
            throw new Error(`${p.project}: Shape has no inbox, so it takes no --copy or --clone.`);
        if (a.noInbox && (p.copy || p.clone))
            throw new Error(`${p.project}: --no-inbox sets up no folder, so it takes no --copy or --clone.`);
        if (p.repo && !p.copy && !p.clone)
            throw new Error(`${p.project}: --repo chooses the repo for --clone or --copy.`);
        if (p.allowUnverified && !p.copy)
            throw new Error(`${p.project}: --allow-unverified-folder goes with --copy <folder>.`);
    }
    return a;
}
/**
 * `<host>/<owner>/<repo>` from a git remote address, lower case, so the ssh and https addresses of one repo (with or
 * without `.git`, `ssh://` or scp form) compare equal. Null for anything else.
 */
export function repoKey(url) {
    const u = url.trim();
    let host;
    let path;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
        try {
            const parsed = new URL(u);
            if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol))
                return null;
            host = parsed.hostname;
            path = decodeURIComponent(parsed.pathname);
        }
        catch {
            return null;
        }
    }
    else {
        const m = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(u);
        if (!m)
            return null;
        host = m[1];
        path = m[2];
    }
    host = host.toLowerCase();
    if (host === "ssh.github.com" || host === "www.github.com")
        host = "github.com";
    const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
    if (parts.length !== 2 || parts.some((x) => !x || x === "." || x === ".."))
        return null;
    return `${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}
const realOrNull = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return null;
    }
};
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
/** Reads folders' git tops and origins once per setup; never prints an origin (an https one can hold a token). */
class GitReader {
    tops = new Map();
    origins = new Map();
    git;
    constructor(git) { this.git = git; }
    top(folder) {
        let t = this.tops.get(folder);
        if (!t) {
            t = this.git(inFolder(folder, "rev-parse", "--show-toplevel"), GIT_TIMEOUT_MS)
                .then((r) => (r.code === 0 ? realOrNull(r.stdout.replace(/\n$/, "")) : null), () => null);
            this.tops.set(folder, t);
        }
        return t;
    }
    origin(top) {
        let o = this.origins.get(top);
        if (!o) {
            o = this.git(inFolder(top, "config", "--get", "remote.origin.url"), GIT_TIMEOUT_MS)
                .then((r) => (r.code === 0 ? repoKey(r.stdout) : null), () => null);
            this.origins.set(top, o);
        }
        return o;
    }
}
/** Server text with control and direction characters taken out, so it cannot rewrite a terminal line. */
export const cleanText = (v) => String(v ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "");
/** The projects as setup uses them: only well-formed names, and the free text cleaned. */
function cleanProjects(all) {
    return all.filter((p) => PROJECT_PATTERN.test(p.project)).map((p) => ({
        ...p, name: cleanText(p.name), organisation: cleanText(p.organisation), role: cleanText(p.role), contribution: contributionOf(p.contribution),
    }));
}
const repoKeyOf = (r) => (r.ssh_url ? repoKey(r.ssh_url) : null);
/**
 * Existing copies of the project's repos: the folder already linked, the current folder, and each `--look` folder,
 * when the top of its git tree has an origin that is one of the repos. A folder that may not be linked, or one in
 * the inbox's own copies, is left out.
 */
async function findCopies(ctx, reader, repos, link, look) {
    const candidates = [];
    if (link && !link.managed)
        candidates.push([link.path, "linked"]);
    candidates.push([ctx.cwd, "cwd"]);
    for (const l of look)
        candidates.push([expandFolder(l, ctx.paths.home, ctx.cwd), "look"]);
    const copies = realOrNull(ctx.paths.reposDir);
    const seen = new Set();
    const out = [];
    for (const [folder, from] of candidates) {
        if (!isDirectory(folder))
            continue;
        const top = await reader.top(folder);
        if (!top || seen.has(top))
            continue;
        seen.add(top);
        if (unsafeFolder(top, ctx.paths) || (copies && within(top, copies)))
            continue;
        const key = await reader.origin(top);
        const repo = key ? repos.find((r) => repoKeyOf(r) === key) : undefined;
        if (repo)
            out.push({ repo: repo.name, path: top, from });
    }
    return out;
}
/** The sign-in for this server as it is, refreshed if needed; never signs in. */
async function currentSignIn(ctx, server) {
    let a;
    try {
        a = loadAuth(ctx.paths);
    }
    catch {
        return { auth: null, problem: "The sign-in file could not be read." };
    }
    if (!a || !a.refresh_token || a.server !== server)
        return { auth: null, problem: null };
    try {
        return { auth: await freshAuth(ctx.paths, { fetch: ctx.fetch }), problem: null };
    }
    catch (err) {
        if (err instanceof SignInNeeded)
            return { auth: null, problem: null };
        return { auth: a, problem: err instanceof Error ? err.message : "Product Map could not be reached." };
    }
}
/** Signed in already (refreshing if needed), or signs in now: the browser's consent page and a loopback callback. */
export async function ensureSignedIn(ctx, server, print = ctx.print, beforeLogin) {
    const prior = loadAuth(ctx.paths);
    if (prior && prior.refresh_token && prior.server === server) {
        try {
            return { auth: await freshAuth(ctx.paths, { fetch: ctx.fetch }), signedIn: false };
        }
        catch (err) {
            if (!(err instanceof SignInNeeded))
                throw err;
        }
    }
    beforeLogin?.();
    const auth = await login(ctx.paths, server, { fetch: ctx.fetch, openBrowser: ctx.openBrowser, print });
    return { auth, signedIn: true };
}
async function readRepos(client, project) {
    try {
        return { repos: await listRepos(client, project), error: null };
    }
    catch (err) {
        if (err instanceof ReposRefused)
            return { repos: null, error: `Product Map refused to list ${project}'s repos.` };
        return { repos: null, error: err instanceof Error ? err.message : "The repos could not be read." };
    }
}
const jobDepsOf = (ctx) => ctx.job;
const isMac = (ctx) => (ctx.job.platform ?? process.platform) === "darwin";
const claudeFor = (ctx) => findClaude(ctx.job.env.PATH, ctx.paths.home, ctx.job.claudeDirs);
/** Which projects setup works on: the ones named, else every one reached. Names not reached are returned apart. */
function chosenProjects(all, named) {
    if (named.length === 0)
        return { items: all.map((item) => ({ item, args: { project: item.project } })), unknown: [] };
    const items = [];
    const unknown = [];
    for (const args of named) {
        const item = all.find((p) => p.project.toLowerCase() === args.project.toLowerCase());
        if (item)
            items.push({ item, args });
        else
            unknown.push(args.project);
    }
    return { items, unknown };
}
/** What is there now, for `setup --plan`. Changes nothing (a sign-in near its expiry may be refreshed). */
export async function planSetup(ctx, args) {
    const server = serverFrom(args.server, ctx.env);
    const signed = await currentSignIn(ctx, server);
    const report = {
        server, hosted: server === DEFAULT_SERVER, signed_in: signed.auth !== null, problem: signed.problem,
        projects: [], not_reached: [], job: checkJob(ctx.paths, jobDepsOf(ctx)), claude: claudeFor(ctx)?.real ?? null,
    };
    if (!signed.auth || signed.problem)
        return report;
    const client = new McpClient(ctx.paths, signed.auth, { fetch: ctx.fetch });
    let all;
    try {
        all = cleanProjects(await listProjects(client));
    }
    catch (err) {
        report.problem = err instanceof Error ? err.message : "The projects could not be listed.";
        return report;
    }
    const { items, unknown } = chosenProjects(all, args.projects);
    report.not_reached = unknown;
    const folders = loadFolders(ctx.paths);
    const reader = new GitReader(ctx.git ?? realGit(ctx.env));
    for (const { item, args: pa } of items) {
        // Shape has no repo step: its repos are not read and no copy is looked for (no git).
        const shape = (pa.role ?? contributionOf(item.contribution)) === "shape";
        const r = shape ? { repos: null, error: null } : await readRepos(client, item.project);
        const link = linkFor(folders, item.project);
        let folder = null;
        if (link) {
            const repo = link.managed ? r.repos?.find((x) => x.name === link.managed?.repo) : undefined;
            folder = {
                path: link.path, kind: link.managed ? "copy" : "own", repo: link.managed?.repo ?? null, track: link.track ?? null,
                tracking: link.managed ? Boolean(repo && link.track === `origin/${repo.default_branch}` && link.managed.url === repo.ssh_url) : Boolean(link.track),
                exists: isDirectory(link.path),
                not_allowed: notAllowed(link, ctx.paths),
            };
        }
        report.projects.push({
            project: item.project, name: item.name, role: item.role, contribution: contributionOf(item.contribution),
            repos: r.repos ? r.repos.map((x) => ({ name: x.name, ssh_url: x.ssh_url, default_branch: x.default_branch })) : null,
            repos_error: r.error,
            folder,
            found: r.repos ? await findCopies(ctx, reader, r.repos, link, args.look) : [],
        });
    }
    return report;
}
const JOB_WORDS = {
    path_has_colon: "not installable: the folder of Claude Code or Node has a \":\" in its name",
    not_installed: "not installed",
    old_job: "installed, but it runs an old copy of the inbox (or another Node or Claude Code)",
    old_code: "installed, but its copy of the inbox is from another version",
    not_loaded: "installed, not loaded",
    no_claude: "installed, but Claude Code was not found",
};
function printPlan(ctx, r) {
    ctx.print(`Server: ${r.server}${r.hosted ? "" : " (not the hosted Product Map)"}.`);
    ctx.print(r.signed_in ? "Signed in." : "Not signed in: setup --yes signs you in (your browser opens Product Map's consent page).");
    if (r.problem)
        ctx.print(r.problem);
    for (const n of r.not_reached)
        ctx.print(`${n}: not among the projects this sign-in reaches.`);
    for (const p of r.projects) {
        ctx.print(`${p.project} (${p.name}): role ${p.contribution ?? "not chosen"}, ${p.role} in Product Map.`);
        if (p.repos_error)
            ctx.print(`  Repos: ${p.repos_error}`);
        else if (p.repos)
            ctx.print(`  Repos: ${p.repos.length ? p.repos.map((x) => `${x.name} (${ownerRepo(x.ssh_url)}, ${x.default_branch || "no branch"})`).join(", ") : "none"}.`);
        if (p.folder) {
            ctx.print(`  Folder: ${p.folder.path}, ${p.folder.kind === "copy" ? `a copy of ${p.folder.repo} kept by the inbox` : "yours"}` +
                `${p.folder.track ? `, tracking ${p.folder.track}` : ""}${p.folder.kind === "copy" && !p.folder.tracking ? " (behind Product Map's repo: setup fixes it)" : ""}${p.folder.exists ? "" : " (missing)"}.`);
            if (p.folder.not_allowed)
                ctx.print(`  ${p.folder.not_allowed}`);
        }
        else
            ctx.print("  Folder: none.");
        for (const f of p.found)
            ctx.print(`  Found a copy of ${f.repo}: ${f.path}.`);
    }
    ctx.print(r.job.supported ? `Job: ${r.job.current ? "installed and up to date" : JOB_WORDS[r.job.problem ?? "not_installed"]}.` : "Job: macOS only for now.");
    ctx.print(r.claude ? `Claude Code: ${r.claude}.` : "Claude Code: not found. The job needs it.");
}
const repoList = (repos) => repos.map((r) => r.name).join(", ");
/** A folder named for a project's requests, checked: it may be linked, and its origin is the project's repo. */
async function checkFolder(ctx, reader, project, folder, repos, repoName, allowUnverified) {
    const abs = expandFolder(folder, ctx.paths.home, ctx.cwd);
    if (!isDirectory(abs))
        return { refused: `There is no folder at ${abs}.` };
    const rp = realpathSync(abs);
    const why = unsafeFolder(rp, ctx.paths);
    if (why)
        return { refused: cannotLink(rp, why) };
    const copies = realOrNull(ctx.paths.reposDir);
    if (copies && within(rp, copies))
        return { refused: `${rp} is a copy the inbox keeps: use --clone for it.` };
    const pool = repoName ? repos.filter((r) => r.name === repoName) : repos;
    if (repoName && pool.length === 0)
        return { refused: `${project} has no repo called ${repoName}. Its repos: ${repoList(repos) || "none"}.` };
    if (repos.length === 0) {
        if (allowUnverified)
            return { path: rp, repo: null };
        return { refused: `it has no repo in Product Map, so setup cannot check that ${rp} holds its code. If you made this folder yourself, add --allow-unverified-folder after --copy. Or add the repo in Project settings, Repos, and use --clone.` };
    }
    const names = pool.map((r) => ownerRepo(r.ssh_url)).join(" or ");
    const top = await reader.top(rp);
    // The top of its own git tree: a folder inside another repository would read that one's origin.
    if (top && top !== rp)
        return { refused: `${rp} is inside a git working tree but is not its top folder. Name the top folder, ${top}.` };
    const key = top ? await reader.origin(top) : null;
    if (!key)
        return { refused: `${rp} is not a git copy of ${names}: it has no origin that names a repo.` };
    const repo = pool.find((r) => repoKeyOf(r) === key);
    if (!repo)
        return { refused: `${rp} is not a copy of ${names}: its origin is another repo.` };
    return { path: rp, repo };
}
/** `--yes`: each project's decision from the flags, or why it is refused. Runs git only to check a `--copy`. */
async function decideFromFlags(ctx, client, reader, args, item, pa) {
    const current = contributionOf(item.contribution);
    const role = pa.role ?? current;
    if (!role) {
        return { refused: `${item.project}: choose your role, --role shape (you write and discuss the work) or --role build (you build it, and may have your agent answer requests on this Mac). Put it after --project ${item.project}.` };
    }
    const p = item.project;
    const base = { item, role, setRole: role !== current };
    if (role === "shape") {
        if (pa.copy || pa.clone || pa.repo) {
            return { refused: `${p}: your role here is shape, which has no inbox, so --copy, --clone and --repo do not apply. Add --role build to use them, or leave them out.` };
        }
        return { ...base, inbox: { kind: "none" }, repos: null };
    }
    if (args.noInbox)
        return { ...base, inbox: { kind: "off" }, repos: null };
    const link = linkFor(loadFolders(ctx.paths), p);
    if (link?.managed && !pa.copy) {
        // The inbox's copy is checked against Product Map now, so anything to refuse is refused before a change.
        const read = await readRepos(client, p);
        if (!read.repos)
            return { refused: `${p}: the inbox's copy at ${link.path} could not be checked. ${read.error}` };
        const repo = read.repos.find((r) => r.name === link.managed?.repo);
        const here = isDirectory(link.path);
        const sameRepo = !pa.repo || pa.repo === link.managed.repo;
        const sameUrl = !repo || repo.ssh_url === link.managed.url;
        if (!pa.clone) {
            if (!here)
                return { refused: `${p}: the inbox's copy at ${link.path} is gone. To copy it again, add --clone after --project ${p}.` };
            if (!sameUrl)
                return { refused: `${p}: Product Map now names ${ownerRepo(repo?.ssh_url ?? null)} for the inbox's copy, a different address. To copy it, add --clone after --project ${p}.` };
            return { ...base, inbox: { kind: "keep", link }, repos: read.repos };
        }
        // --clone of the copy it already is, in place and at the same address: kept, with no lock and no git.
        if (here && sameRepo && repo && sameUrl)
            return { ...base, inbox: { kind: "keep", link }, repos: read.repos };
    }
    if (link && !link.managed) {
        const refusedNow = notAllowed(link, ctx.paths);
        if (refusedNow && !(pa.replace && (pa.copy || pa.clone)))
            return { refused: `${p}: ${refusedNow.replace("Link another folder with setup.", `Name another with --copy <folder> --replace, or --clone --replace, after --project ${p}.`)}` };
        if (pa.copy && realOrNull(expandFolder(pa.copy, ctx.paths.home, ctx.cwd)) === realOrNull(link.path)) {
            // The folder linked already: said so, and still checked against the repo.
            const read = await readRepos(client, p);
            if (!read.repos)
                return { refused: `${p}: ${read.error}` };
            // Linked already, so a project with no repo keeps it without --allow-unverified-folder.
            const c = await checkFolder(ctx, reader, p, pa.copy, read.repos, pa.repo, true);
            if ("refused" in c)
                return { refused: `${p}: ${link.path} is already linked, but ${c.refused}` };
            return { ...base, inbox: { kind: "keep", link, note: `${link.path} is already linked.` }, repos: read.repos };
        }
        if (!pa.copy && !pa.clone)
            return { ...base, inbox: { kind: "keep", link }, repos: null };
        if (!pa.replace) {
            return { ...base, inbox: { kind: "keep", link, note: `kept the folder you linked, ${link.path}. Add --replace after --project ${p} to change it.` }, repos: null };
        }
    }
    const read = await readRepos(client, item.project);
    if (!read.repos)
        return { refused: `${item.project}: ${read.error}` };
    const repos = read.repos;
    if (pa.clone) {
        if (repos.length === 0)
            return { refused: `${item.project} has no repo in Product Map, so there is nothing to copy. Add one in Project settings, Repos, or name a folder with --copy <folder>.` };
        const repo = pa.repo ? repos.find((r) => r.name === pa.repo) : repos.length === 1 ? repos[0] : undefined;
        if (!repo) {
            return { refused: pa.repo
                    ? `${item.project} has no repo called ${pa.repo}. Its repos: ${repoList(repos)}.`
                    : `${item.project} has several repos (${repoList(repos)}). Choose one with --repo <name> after --project ${item.project}.` };
        }
        return { ...base, inbox: { kind: "clone", repo, replacing: link }, repos };
    }
    if (pa.copy) {
        const c = await checkFolder(ctx, reader, item.project, pa.copy, repos, pa.repo, pa.allowUnverified === true);
        if ("refused" in c)
            return { refused: `${item.project}: ${c.refused}` };
        return { ...base, inbox: { kind: "copy", path: c.path, repo: c.repo, replacing: link }, repos };
    }
    if (repos.length === 0) {
        return { refused: `${item.project} has no repo in Product Map, so your agent needs a folder: add --copy <folder> after --project ${item.project}. Or add --no-inbox to leave the inbox off.` };
    }
    const which = repos.length === 1 ? ownerRepo(repos[0].ssh_url) : `one of its repos (${repoList(repos)}, with --repo <name>)`;
    return { refused: `${item.project}: choose where your agent reads ${which}: --clone to keep a copy for it, or --copy <folder> to use a copy you have. Put it after --project ${item.project}. Or add --no-inbox to leave the inbox off.` };
}
const yes = (s) => /^y(es)?$/i.test(s.trim());
const no = (s) => /^no?$/i.test(s.trim());
/** In a terminal: the same decision, asking for what the flags leave open, in the same order. Null skips the project. */
async function decideByAsking(ctx, client, reader, args, item, pa) {
    const current = contributionOf(item.contribution);
    let role = pa.role ?? null;
    while (!role) {
        const a = (await ctx.ask(current
            ? `Your role in ${item.project} (${item.name}) is ${current}. Enter keeps it, or type shape or build: `
            : `In ${item.project} (${item.name}), do you shape the work (write and discuss it) or build it? Type shape or build (Enter skips this project): `)).trim().toLowerCase();
        if (!a && current)
            role = current;
        else if (!a) {
            ctx.print(`Skipped ${item.project}: no role chosen.`);
            return null;
        }
        else if (a === "shape" || a === "build")
            role = a;
        else
            ctx.print("Type shape or build.");
    }
    const base = { item, role, setRole: role !== current };
    if (role === "shape")
        return { ...base, inbox: { kind: "none" }, repos: null };
    if (args.noInbox)
        return { ...base, inbox: { kind: "off" }, repos: null };
    const link = linkFor(loadFolders(ctx.paths), item.project);
    if (!pa.copy && !pa.clone) {
        const a = await ctx.ask(`Should your agent answer requests for ${item.project} in the background? ${link ? "[Y/n]" : "[y/N]"} `);
        if (link ? no(a) : !yes(a)) {
            if (link)
                ctx.print(`${item.project} still has ${link.path} linked. To stop requests running there: npx product-map-inbox unlink ${item.project}`);
            return { ...base, inbox: { kind: "off" }, repos: null };
        }
        const refusedNow = link ? notAllowed(link, ctx.paths) : null;
        if (refusedNow)
            ctx.print(refusedNow);
        if (link && !refusedNow && !no(await ctx.ask(`Keep ${link.path}${link.managed ? `, the inbox's copy of ${link.managed.repo}` : ""}? [Y/n] `))) {
            const repos = link.managed ? (await readRepos(client, item.project)).repos : null;
            return { ...base, inbox: { kind: "keep", link }, repos };
        }
    }
    const read = await readRepos(client, item.project);
    if (read.error)
        ctx.print(`${item.project}: ${read.error}`);
    const repos = read.repos ?? [];
    if (pa.copy || pa.clone) {
        // A choice given as a flag is checked as --yes checks it.
        const d = await decideFromFlags(ctx, client, reader, { ...args, noInbox: false }, { ...item, contribution: role }, { ...pa, role, replace: true, allowUnverified: true });
        if ("refused" in d) {
            ctx.print(d.refused);
            return { ...base, inbox: { kind: "off" }, repos: null };
        }
        return { ...d, setRole: role !== current };
    }
    const found = repos.length ? await findCopies(ctx, reader, repos, link, args.look) : [];
    for (const repo of repos) {
        for (const f of found.filter((x) => x.repo === repo.name)) {
            if (yes(await ctx.ask(`Use ${f.path} for ${item.project}'s requests (a copy of ${ownerRepo(repo.ssh_url)})? [y/N] `))) {
                ctx.print("Runs read that folder as it is, on whatever branch it has out, and never pull it.");
                return { ...base, inbox: { kind: "copy", path: f.path, repo, replacing: link }, repos };
            }
        }
        if (repo.ssh_url && yes(await ctx.ask(`Keep a copy of ${ownerRepo(repo.ssh_url)} (branch ${repo.default_branch || "none"}) on this Mac for your agent? [y/N] `))) {
            return { ...base, inbox: { kind: "clone", repo, replacing: link }, repos };
        }
    }
    for (;;) {
        const answer = (await ctx.ask(`Folder for ${item.project}'s requests (Enter skips): `)).trim();
        if (!answer)
            return { ...base, inbox: { kind: "off" }, repos: null };
        if (link?.track && !link.managed) {
            // A new folder for a tracked project keeps tracking the same branch, so it is checked as `link --track` is.
            const abs = expandFolder(answer, ctx.paths.home, ctx.cwd);
            if (!isDirectory(abs)) {
                ctx.print(`There is no folder at ${abs}.`);
                continue;
            }
            const rp = realpathSync(abs);
            const why = unsafeFolder(rp, ctx.paths);
            if (why) {
                ctx.print(cannotLink(rp, why));
                continue;
            }
            try {
                await checkTrack(ctx.git ?? realGit(ctx.env), rp, parseTrack(link.track));
            }
            catch (err) {
                ctx.print(err instanceof Error ? err.message : "That folder cannot track the branch.");
                continue;
            }
            return { ...base, inbox: { kind: "copy", path: rp, repo: null, replacing: link, track: link.track }, repos };
        }
        // Typed at the terminal: a folder for a project with no repo is the person's own choice.
        const c = await checkFolder(ctx, reader, item.project, answer, repos, undefined, true);
        if ("refused" in c) {
            ctx.print(c.refused);
            continue;
        }
        return { ...base, inbox: { kind: "copy", path: c.path, repo: c.repo, replacing: link }, repos };
    }
}
const READ_AS_IS = (path) => `Runs read ${path} as it is, on whatever branch it has out, and never pull it. To read current code, use --clone instead, or link a worktree kept for the inbox with npx product-map-inbox link --track.`;
/** Does each decision's steps, in order. A step that fails is said and the next project goes on. */
async function carryOut(ctx, client, decisions, say) {
    let ok = true;
    let inboxOn = false;
    let lock = null;
    const fail = (project, step, message) => { ok = false; say({ project, step, outcome: "failed", message }); };
    const holdLock = () => {
        lock ??= takeLock(ctx.paths.lock);
        return lock !== null;
    };
    const BUSY = "The background job is working right now (a request's run can take up to 15 minutes). Run setup again when npx product-map-inbox status shows its last tick finished.";
    try {
        // Every role first, once every project has been decided. Product Map can still refuse one: then nothing more
        // is done, and the roles already set are named.
        const setRoles = [];
        for (const d of decisions) {
            const p = d.item.project;
            if (!d.setRole) {
                say({ project: p, step: "role", outcome: "unchanged", message: `your role is ${d.role}.` });
                continue;
            }
            try {
                const r = await setContribution(client, p, d.role);
                say({ project: p, step: "role", outcome: "done", message: `your role is now ${r.contribution ?? d.role}.` });
                setRoles.push(`${p} (${d.role})`);
            }
            catch (err) {
                fail(p, "role", cleanText(err instanceof Error ? err.message : "Product Map did not set the role."));
                say({ project: null, step: "role", outcome: "skipped", message: setRoles.length
                        ? `Stopped. Roles already set: ${setRoles.join(", ")}. No folder, copy or job was changed.`
                        : "Stopped. No role, folder, copy or job was changed." });
                return { inboxOn: false, ok: false };
            }
        }
        for (const d of decisions) {
            const p = d.item.project;
            const inbox = d.inbox;
            switch (inbox.kind) {
                case "none": {
                    const link = linkFor(loadFolders(ctx.paths), p);
                    say({ project: p, step: "folder", outcome: "skipped", message: `Shape: nothing more to set up on this Mac.${link ? ` ${link.path} is still linked; to stop requests running there: npx product-map-inbox unlink ${p}` : ""}` });
                    break;
                }
                case "off":
                    say({ project: p, step: "folder", outcome: "skipped", message: "the inbox is off for this project. To turn it on, run setup again without --no-inbox." });
                    break;
                case "keep": {
                    const link = inbox.link;
                    if (!link.managed) {
                        if (!isDirectory(link.path)) {
                            fail(p, "folder", `the folder linked, ${link.path}, is gone. Name another with --copy <folder> --replace.`);
                            break;
                        }
                        say({ project: p, step: "folder", outcome: "unchanged", message: inbox.note ?? `kept ${link.path}${link.track ? `, tracking ${link.track}` : ""}.` });
                        inboxOn = true;
                        break;
                    }
                    if (!d.repos) {
                        fail(p, "folder", `the inbox's copy at ${link.path} could not be checked: Product Map's list of repos could not be read. Run setup again later.`);
                        inboxOn = true;
                        break;
                    }
                    if (!isDirectory(link.path)) {
                        fail(p, "folder", `the inbox's copy at ${link.path} is gone. To copy it again, run setup again with --project ${p} --clone.`);
                        break;
                    }
                    // In line with Product Map already: nothing to change, so the job's lock is not needed.
                    const same = d.repos.find((x) => x.name === link.managed?.repo);
                    if (same && same.ssh_url === link.managed.url && link.track === `origin/${same.default_branch}`) {
                        say({ project: p, step: "folder", outcome: "unchanged", message: inbox.note ?? `kept the inbox's copy of ${same.name} at ${link.path}, tracking ${link.track}.` });
                        inboxOn = true;
                        break;
                    }
                    if (!holdLock()) {
                        fail(p, "folder", BUSY);
                        break;
                    }
                    const r = await ensureCopy(ctx.paths, ctx.copyGit ?? realGit(ctx.env, { clone: true }), p, d.repos);
                    if (r.kind === "ready") {
                        const moved = r.link.track !== link.track;
                        say({ project: p, step: "folder", outcome: moved ? "done" : "unchanged", message: moved
                                ? `the inbox's copy at ${r.link.path} now follows ${r.link.track} (it followed ${link.track}).`
                                : inbox.note ?? `kept the inbox's copy of ${r.repo.name} at ${r.link.path}, tracking ${r.link.track}.` });
                        inboxOn = true;
                    }
                    else if (r.kind === "needs_consent") {
                        fail(p, "folder", `Product Map now names ${ownerRepo(r.repo.ssh_url)} for this copy, a different address. To copy it, run setup again with --project ${p} --clone.`);
                    }
                    else if (r.kind === "failed")
                        fail(p, "folder", failureMessage(r.failure, r.repo));
                    else if (r.kind === "no_repo" || r.kind === "several") {
                        say({ project: p, step: "folder", outcome: "done", message: `the copy's repo is no longer in Product Map, so the inbox let the copy go. Choose a folder with --copy or --clone.` });
                    }
                    break;
                }
                case "copy": {
                    const old = inbox.replacing;
                    if (old && old.path === inbox.path && !old.managed && (old.track ?? undefined) === inbox.track) {
                        say({ project: p, step: "folder", outcome: "unchanged", message: `kept ${old.path}.` });
                        inboxOn = true;
                        break;
                    }
                    try {
                        if (inbox.track)
                            await linkTracked(ctx.paths, p, inbox.path, ctx.cwd, inbox.track, ctx.git ?? realGit(ctx.env));
                        else
                            linkPlain(ctx.paths, p, inbox.path, ctx.cwd);
                    }
                    catch (err) {
                        fail(p, "folder", err instanceof Error ? err.message : "That folder could not be linked.");
                        break;
                    }
                    say({ project: p, step: "folder", outcome: "done", message: `linked ${inbox.path}${inbox.track ? `, tracking ${inbox.track}` : ""}${old ? ` (was ${old.path})` : ""}. ${inbox.track ? "" : READ_AS_IS(inbox.path)}`.trim() });
                    if (old?.managed)
                        say({ project: p, step: "folder", outcome: "done", message: `the inbox's old copy is still at ${old.path}. Delete it when you no longer need it.` });
                    inboxOn = true;
                    break;
                }
                case "clone": {
                    if (!holdLock()) {
                        fail(p, "folder", BUSY);
                        break;
                    }
                    const old = inbox.replacing;
                    // A folder of the person's is let go only for this, and put back when the copy cannot be made.
                    if (old && !old.managed)
                        unlinkLink(ctx.paths, p);
                    let r;
                    try {
                        r = await ensureCopy(ctx.paths, ctx.copyGit ?? realGit(ctx.env, { clone: true }), p, d.repos ?? [inbox.repo], { choose: inbox.repo.name, consent: true });
                    }
                    catch (err) {
                        if (old && !old.managed)
                            restoreLink(ctx.paths, p, old);
                        fail(p, "folder", err instanceof Error ? err.message : "The copy could not be made.");
                        break;
                    }
                    if (r.kind !== "ready" && old && !old.managed)
                        restoreLink(ctx.paths, p, old);
                    if (r.kind === "ready") {
                        say({ project: p, step: "folder", outcome: r.cloned ? "done" : "unchanged", message: r.cloned
                                ? `cloned ${ownerRepo(r.repo.ssh_url)} into ${r.link.path}. Before each run it is brought up to ${r.link.track}.`
                                : `kept the inbox's copy of ${r.repo.name} at ${r.link.path}, tracking ${r.link.track}.` });
                        if (r.kept)
                            say({ project: p, step: "folder", outcome: "done", message: `the old copy had changes, so it was moved to ${r.kept}, not deleted.` });
                        if (old && !old.managed)
                            say({ project: p, step: "folder", outcome: "done", message: `${old.path} is no longer linked; nothing in it was changed.` });
                        inboxOn = true;
                    }
                    else if (r.kind === "failed")
                        fail(p, "folder", failureMessage(r.failure, r.repo));
                    else if (r.kind === "several")
                        fail(p, "folder", `${p} has no repo called ${inbox.repo.name} now. Its repos: ${r.names.join(", ") || "none"}.`);
                    else if (r.kind === "no_repo")
                        fail(p, "folder", `${p} has no repo in Product Map now.`);
                    else
                        fail(p, "folder", `the copy of ${inbox.repo.name} could not be made.`);
                    break;
                }
            }
        }
    }
    finally {
        lock?.release();
    }
    return { inboxOn, ok };
}
/** The skill and the job, when at least one project has the inbox on. */
function installJob(ctx, say) {
    const skill = installSkill(ctx.paths);
    say({ project: null, step: "skill", outcome: skill === "unchanged" ? "unchanged" : "done", message: `Skill ${skill}: ${ctx.paths.skill}` });
    if (!isMac(ctx)) {
        say({ project: null, step: "job", outcome: "skipped", message: "The background job is macOS only for now. Run npx product-map-inbox poll from your own scheduler." });
        return true;
    }
    const c = checkJob(ctx.paths, ctx.job);
    if (c.problem === "path_has_colon") {
        say({ project: null, step: "job", outcome: "failed", message: jobPathProblem(ctx.paths, ctx.job) ?? "The job's PATH cannot be written." });
        return false;
    }
    if (c.current) {
        say({ project: null, step: "job", outcome: "unchanged", message: `Job installed and up to date: ${ctx.paths.plist}.` });
        return true;
    }
    try {
        const done = install(ctx.paths, ctx.job);
        const why = c.problem === "not_installed" ? "Job installed" : `Job updated (it was ${JOB_WORDS[c.problem ?? "old_job"]})`;
        say({ project: null, step: "job", outcome: "done", message: `${why}: ${done.plist}, every 60 seconds, running Claude Code from ${done.claude}. Log: ${ctx.paths.log}` });
        return true;
    }
    catch (err) {
        say({ project: null, step: "job", outcome: "failed", message: err instanceof Error ? err.message : "The job could not be installed." });
        return false;
    }
}
const TRY_IT = "Try it: in Product Map, open an entry in a project with the inbox on, mark it for agent input and write what you want. Your agent answers it within a minute or two while this Mac is awake.";
const SHAPE_ONLY = "Done. To have your agent answer requests on this Mac later, run setup again with --role build and --clone or --copy <folder>.";
/**
 * `setup --yes`, and `setup` in a terminal: part 1 (sign-in, projects, roles), then part 2 for Build projects with
 * the inbox on. With `--yes` every project is decided before anything changes, and one that cannot be is refused.
 */
export async function runSetup(ctx, args) {
    const server = serverFrom(args.server, ctx.env);
    const result = { ok: false, server, signed_in: false, refused: [], steps: [], next: null };
    const say = (s) => {
        result.steps.push(s);
        if (!args.json)
            ctx.print(`${s.project ? `${s.project}: ` : ""}${s.message}`);
    };
    const refuse = (message) => {
        result.refused.push(message);
        if (!args.json)
            ctx.print(message);
        return result;
    };
    if (server !== DEFAULT_SERVER) {
        if (args.yes) {
            if (!args.server)
                return refuse(`PRODUCT_MAP_MCP_URL names ${server}, not the hosted Product Map. setup --yes uses another server only when it is named with --server and --yes-other-server.`);
            if (!args.yesOtherServer)
                return refuse(`${server} is not the hosted Product Map: your sign-in and your requests' answers would go to that server. Add --yes-other-server if you mean it.`);
        }
        else {
            ctx.print(`Warning: this signs in to ${server}, not the hosted Product Map. Your sign-in and your requests' answers go to that server.`);
            if (!yes(await ctx.ask("Use it? Type yes to go on: ")))
                throw new Error("Stopped: nothing was changed.");
        }
    }
    // The sign-in prints the consent page's address; with --json that goes to stderr so stdout stays one object.
    const toStderr = ctx.warn ?? ctx.print;
    const signIn = await ensureSignedIn(ctx, server, args.json ? (ctx.warn ?? (() => { })) : ctx.print, args.yes
        ? () => toStderr("Signing in: your browser opens Product Map's consent page, and setup waits up to 5 minutes for you to approve it.")
        : undefined);
    result.signed_in = true;
    say({ project: null, step: "sign_in", outcome: signIn.signedIn ? "done" : "unchanged", message: signIn.signedIn ? `Signed in to ${server}.` : `Signed in to ${server} already.` });
    const client = new McpClient(ctx.paths, signIn.auth, { fetch: ctx.fetch });
    const all = cleanProjects(await listProjects(client));
    if (all.length === 0) {
        say({ project: null, step: "sign_in", outcome: "skipped", message: "This sign-in reaches no projects yet. Add one on Product Map's Connected agents page, then run setup again." });
        result.ok = true;
        return result;
    }
    const { items, unknown } = chosenProjects(all, args.projects);
    // Only a sign-in made just now has been written by then.
    const unchanged = signIn.signedIn
        ? "Nothing else was changed: you are signed in now. Run setup --plan --json to see each project."
        : "Nothing was changed. Run setup --plan --json to see each project.";
    for (const n of unknown)
        refuse(`${n} is not among the projects this sign-in reaches (${all.map((p) => p.project).join(", ")}).`);
    if (unknown.length) {
        if (!args.json)
            ctx.print(unchanged);
        return result;
    }
    const reader = new GitReader(ctx.git ?? realGit(ctx.env));
    const decisions = [];
    if (args.yes) {
        for (const { item, args: pa } of items) {
            const d = await decideFromFlags(ctx, client, reader, args, item, pa);
            if ("refused" in d)
                refuse(d.refused);
            else
                decisions.push(d);
        }
        // The job is checked as well, so a PATH it cannot be given refuses before any change.
        const wantsJob = decisions.some((d) => d.inbox.kind === "keep" || d.inbox.kind === "copy" || d.inbox.kind === "clone");
        const colon = wantsJob && isMac(ctx) ? jobPathProblem(ctx.paths, ctx.job) : null;
        if (colon)
            refuse(colon);
        if (result.refused.length) {
            if (!args.json)
                ctx.print(unchanged);
            return result;
        }
    }
    else {
        ctx.print("Link only folders you trust. A run is given the folder's CLAUDE.md, and can repeat what it says into a comment on the entry: link only folders whose CLAUDE.md holds nothing secret.");
        for (const { item, args: pa } of items) {
            const d = await decideByAsking(ctx, client, reader, args, item, pa);
            if (d)
                decisions.push(d);
        }
    }
    const done = await carryOut(ctx, client, decisions, say);
    let ok = done.ok;
    if (done.inboxOn)
        ok = installJob(ctx, say) && ok;
    result.ok = ok;
    result.next = done.inboxOn ? TRY_IT : decisions.length ? SHAPE_ONLY : null;
    if (result.next && !args.json)
        ctx.print(result.next);
    return result;
}
/** `setup` with its flags: the plan, the run, or the questions. Returns whether everything went through. */
export async function setupCommand(ctx, args) {
    if (args.plan) {
        if (!args.json) {
            printPlan(ctx, await planSetup(ctx, args));
            return true;
        }
        try {
            ctx.print(JSON.stringify(await planSetup(ctx, args), null, 2));
            return true;
        }
        catch (err) {
            ctx.print(JSON.stringify({ ok: false, error: cleanText(err instanceof Error ? err.message : "Something went wrong.") }, null, 2));
            return false;
        }
    }
    if (!args.yes && !ctx.interactive) {
        throw new Error("setup asks questions, so it needs a terminal. Without one, run npx product-map-inbox setup --plan --json to see what is there, then setup --yes with your choices (see the README).");
    }
    if (!args.json)
        return (await runSetup(ctx, args)).ok;
    try {
        const r = await runSetup(ctx, args);
        ctx.print(JSON.stringify(r, null, 2));
        return r.ok;
    }
    catch (err) {
        ctx.print(JSON.stringify({ ok: false, error: cleanText(err instanceof Error ? err.message : "Something went wrong.") }, null, 2));
        return false;
    }
}
