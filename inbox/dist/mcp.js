// A minimal MCP client over the streamable HTTP transport: JSON-RPC POSTs with the bearer token, plain JSON or SSE
// answers. A 401 refreshes the sign-in once and tries again.
import { createHash } from "node:crypto";
import { FETCH_OPTIONS, fetchSignal, freshAuth, ServerUnavailable, SignInNeeded, unreachable } from "./auth.js";
export const PROTOCOL_VERSION = "2025-06-18";
/** Product Map answered a call with a JSON-RPC error (`code`): -32602 is a tool the server does not have. */
export class RpcError extends ServerUnavailable {
    code;
    constructor(code) {
        super(`Product Map refused the request (JSON-RPC ${code ?? "error"}).`);
        this.name = "RpcError";
        this.code = code;
    }
}
export class McpClient {
    id = 0;
    auth;
    paths;
    fetchFn;
    initialized = false;
    now;
    constructor(paths, auth, opts = {}) {
        this.paths = paths;
        this.auth = auth;
        this.fetchFn = opts.fetch ?? fetch;
        this.now = opts.now ?? Date.now;
    }
    get currentAuth() { return this.auth; }
    async post(body, retried = false) {
        let r;
        try {
            r = await this.fetchFn(this.auth.server, {
                ...FETCH_OPTIONS, signal: fetchSignal(),
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    accept: "application/json, text/event-stream",
                    authorization: `Bearer ${this.auth.access_token ?? ""}`,
                    ...(this.initialized ? { "mcp-protocol-version": PROTOCOL_VERSION } : {}),
                },
                body: JSON.stringify(body),
            });
        }
        catch {
            throw unreachable();
        }
        if (r.status === 401 && !retried) {
            this.auth = await freshAuth(this.paths, { fetch: this.fetchFn, now: this.now, rejected: this.auth.access_token ?? "" });
            return this.post(body, true);
        }
        if (r.status === 401)
            throw new SignInNeeded("Product Map no longer accepts this sign-in.");
        return r;
    }
    async request(method, params) {
        const id = ++this.id;
        const r = await this.post({ jsonrpc: "2.0", id, method, params });
        if (r.status === 429)
            throw new ServerUnavailable("Product Map is limiting requests from this machine (HTTP 429).");
        if (r.status !== 200)
            throw new ServerUnavailable(`Product Map answered HTTP ${r.status}.`);
        const msg = await readMessage(r, id);
        if (msg.error) {
            const e = msg.error;
            throw new RpcError(typeof e.code === "number" ? e.code : null);
        }
        return (msg.result ?? {});
    }
    async initialize() {
        if (this.initialized)
            return;
        await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "product-map-inbox", version: "0.1.0" },
        });
        this.initialized = true;
        const r = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
        // Nothing is read from the answer (202, no body); its body is let go so the connection is freed.
        await r.body?.cancel().catch(() => { });
    }
    async callTool(name, args) {
        await this.initialize();
        const result = await this.request("tools/call", { name, arguments: args });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
            .filter((c) => typeof c === "object" && c !== null && c.type === "text")
            .map((c) => c.text).join("\n");
        return { isError: result.isError === true, text };
    }
}
/** The JSON-RPC answer with this id, from a JSON body or from the first matching SSE `data:` event. */
async function readMessage(r, id) {
    const text = await r.text();
    const type = r.headers.get("content-type") ?? "";
    const candidates = [];
    if (type.includes("text/event-stream")) {
        for (const block of text.split(/\r?\n\r?\n/)) {
            const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data)
                continue;
            try {
                candidates.push(JSON.parse(data));
            }
            catch { /* not JSON: skip */ }
        }
    }
    else {
        try {
            candidates.push(JSON.parse(text));
        }
        catch { /* handled below */ }
    }
    for (const c of candidates.flat()) {
        if (typeof c === "object" && c !== null && c.id === id)
            return c;
    }
    throw new ServerUnavailable("Product Map's answer could not be read.");
}
/**
 * The JSON a tool returned. Product Map puts a one-line label before the JSON ("The following is …"), so the JSON
 * starts at the first line that opens an object.
 */
export function toolJson(text) {
    const at = text.search(/^\{/m);
    if (at < 0)
        throw new ServerUnavailable("Product Map's answer held no data.");
    try {
        return JSON.parse(text.slice(at));
    }
    catch {
        throw new ServerUnavailable("Product Map's answer could not be read.");
    }
}
export const contributionOf = (v) => (v === "shape" || v === "build" ? v : null);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const ENTRY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,19}-[0-9]{1,9}$/;
export async function listAgentRequests(client) {
    const a = await client.callTool("list_agent_requests", {});
    if (a.isError)
        throw new ServerUnavailable("Product Map refused to list the requests.");
    const data = toolJson(a.text);
    const rows = Array.isArray(data.requests) ? data.requests : [];
    // Only the fields the job needs are kept, and only in their expected shape (they reach a command line, a hook's
    // arguments and the log): the prompt and the entry's title never leave this function.
    return rows.flatMap((r) => {
        if (typeof r !== "object" || r === null)
            return [];
        const o = r;
        if (typeof o.request !== "string" || !UUID.test(o.request))
            return [];
        if (typeof o.project !== "string" || !PROJECT_PATTERN.test(o.project))
            return [];
        if (typeof o.entry !== "string" || !ENTRY_PATTERN.test(o.entry))
            return [];
        const preset = o.preset === 1 || o.preset === 2 || o.preset === 3 || o.preset === 4 ? o.preset : null;
        return [{
                request: o.request.toLowerCase(), project: o.project, entry: o.entry,
                asked_at: typeof o.asked_at === "string" ? o.asked_at : "",
                preset,
                prompt_hash: createHash("sha256").update(typeof o.prompt === "string" ? o.prompt : "").digest("hex"),
            }];
    });
}
export async function listProjects(client) {
    const a = await client.callTool("list_projects", {});
    if (a.isError)
        throw new ServerUnavailable("Product Map refused to list the projects.");
    const data = toolJson(a.text);
    return (Array.isArray(data.projects) ? data.projects : []).filter((p) => typeof p === "object" && p !== null && typeof p.project === "string");
}
export const NO_SET_CONTRIBUTION = "This Product Map server cannot set a role yet (it has no set_contribution tool). Choose your role for the project in Product Map, then run setup again.";
/**
 * Sets the person's role in a project (`set_contribution`, PDM-55 WU-08). A refusal (a commenter asking for build,
 * say) is thrown in Product Map's own words; a server without the tool is said plainly.
 */
export async function setContribution(client, project, role) {
    let a;
    try {
        a = await client.callTool("set_contribution", { project, role });
    }
    catch (err) {
        if (err instanceof RpcError && err.code === -32602)
            throw new Error(NO_SET_CONTRIBUTION);
        throw err;
    }
    const text = a.text.trim();
    if (a.isError) {
        if (/^unknown tool\b/i.test(text))
            throw new Error(NO_SET_CONTRIBUTION);
        // The server's own words, with control and direction characters taken out.
        const words = text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/ {2,}/g, " ").trim();
        throw new Error(words.slice(0, 500) || `Product Map refused to set your role in ${project}.`);
    }
    const d = toolJson(text);
    return { project: typeof d.project === "string" ? d.project : project, contribution: contributionOf(d.contribution) };
}
/** A plugin version as `report_setup` takes it (the server holds it to the same shape and 64 characters). */
export const PLUGIN_VERSION = /^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
/**
 * Tells Product Map which plugin version set up this sign-in's connection (`report_setup`, PDM-55 WU-09), for the
 * Connected agents page. Null when it was recorded; otherwise why not, in plain words (a server without the tool, a
 * refusal, no answer). It never throws: setup has done its work by then, and this is only a note on it.
 */
export async function reportSetup(client, version) {
    try {
        const a = await client.callTool("report_setup", { version });
        if (!a.isError) {
            let reported;
            try {
                reported = toolJson(a.text).reported;
            }
            catch {
                reported = undefined;
            }
            return reported === true ? null : "this sign-in has no agent connection";
        }
        if (/^unknown tool\b/i.test(a.text.trim()))
            return "this Product Map server does not take a version yet";
        return a.text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 300) || "Product Map refused it";
    }
    catch (err) {
        if (err instanceof RpcError && err.code === -32602)
            return "this Product Map server does not take a version yet";
        return err instanceof Error ? err.message : "Product Map could not be reached";
    }
}
/** A repo's name as Product Map holds it (`project_repos.name`): a slug of at most 40 characters. */
export const REPO_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REPO_NAME_MAX = 40;
/** The only address a copy is cloned from: GitHub over ssh, with an owner and repo name of the characters GitHub allows. */
export const SSH_URL = /^git@github\.com:[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}\.git$/;
/** The project's repos (PDM-55 WU-01's `list_repos`), read as the person each time they are needed, never kept. */
/** Product Map answered `list_repos` with a refusal (a project it does not share, or a server without the tool). */
export class ReposRefused extends Error {
    constructor() { super("Product Map refused to list the project's repos."); this.name = "ReposRefused"; }
}
export async function listRepos(client, project) {
    const a = await client.callTool("list_repos", { project });
    if (a.isError)
        throw new ReposRefused();
    const data = toolJson(a.text);
    // A reply that is not a list of repos, or holds a row this package cannot read, is no answer at all: read as
    // "fewer repos" it could let go of a copy whose repo is still there.
    if (!Array.isArray(data.repos))
        throw new ServerUnavailable("Product Map's list of repos could not be read.");
    return data.repos.map((r) => {
        const o = (typeof r === "object" && r !== null ? r : {});
        if (typeof o.name !== "string" || o.name.length > REPO_NAME_MAX || !REPO_NAME.test(o.name))
            throw new ServerUnavailable("Product Map's list of repos could not be read.");
        const ssh = typeof o.ssh_url === "string" && SSH_URL.test(o.ssh_url) ? o.ssh_url : null;
        return { name: o.name, ssh_url: ssh, default_branch: typeof o.default_branch === "string" ? o.default_branch : "" };
    });
}
export const NO_FOLDER_NOTE = "No folder is set up for this project on your machine.";
export const GAVE_UP_NOTE = "Your agent could not take this request. Change or cancel it.";
export async function holdAgentRequest(client, request, note) {
    const a = await client.callTool("hold_agent_request", { request, note });
    return !a.isError;
}
