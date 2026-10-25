// Sign-in: dynamic client registration, PKCE (S256) and a loopback callback on 127.0.0.1, then the code exchange.
// The tokens are kept in ~/.config/product-map/agent-inbox.json (600, directory 700). The access token lasts an
// hour and the refresh token rotates on every use, so each refresh is saved before anything else happens.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, rmSync } from "node:fs";
import { looserThanPrivate, readJson, writePrivateJson } from "./files.js";
import { takeLock } from "./lock.js";
export const SIGN_IN_AGAIN = "Sign in again with npx product-map-inbox login";
/** The sign-in is gone (no tokens, or the server refused the refresh): only a new sign-in helps. */
export class SignInNeeded extends Error {
    constructor(why) {
        super(why ? `${why} ${SIGN_IN_AGAIN}.` : `${SIGN_IN_AGAIN}.`);
        this.name = "SignInNeeded";
    }
}
/** The server could not be reached, or answered with a server error: the next try may work. */
export class ServerUnavailable extends Error {
    constructor(what) {
        super(what);
        this.name = "ServerUnavailable";
    }
}
const b64url = (buf) => buf.toString("base64url");
export const newVerifier = () => b64url(randomBytes(32));
export const challengeFor = (verifier) => b64url(createHash("sha256").update(verifier).digest());
export const endpoints = (server) => ({
    register: `${server}/oauth/register`,
    authorize: `${server}/oauth/authorize`,
    token: `${server}/oauth/token`,
});
/** Every request this package makes: no redirects followed, and a 30-second limit. */
export const FETCH_OPTIONS = { redirect: "error" };
export const fetchSignal = () => AbortSignal.timeout(30_000);
/** Told once per process when the token file was readable by others (it is put back to 600). */
let warnedMode = false;
export function loadAuth(paths) {
    if (looserThanPrivate(paths.auth)) {
        try {
            chmodSync(paths.auth, 0o600);
        }
        catch { /* the warning still stands */ }
        if (!warnedMode) {
            warnedMode = true;
            console.error(`Warning: ${paths.auth} was readable by other users. It is now 600; if you did not change it, sign in again.`);
        }
    }
    const a = readJson(paths.auth);
    if (!a || typeof a.server !== "string" || typeof a.client_id !== "string")
        return null;
    return a;
}
export const saveAuth = (paths, auth) => writePrivateJson(paths.auth, auth);
async function tokenRequest(fetchFn, server, form) {
    let r;
    try {
        r = await fetchFn(endpoints(server).token, {
            ...FETCH_OPTIONS, signal: fetchSignal(),
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams(form).toString(),
        });
    }
    catch {
        throw new ServerUnavailable("Could not reach Product Map.");
    }
    let body = {};
    try {
        body = (await r.json());
    }
    catch {
        body = {};
    }
    return { status: r.status, body };
}
function tokensFrom(body) {
    const { access_token, refresh_token, expires_in } = body;
    if (typeof access_token !== "string" || !access_token || typeof refresh_token !== "string" || !refresh_token)
        return null;
    return { access_token, refresh_token, expires_in: typeof expires_in === "number" && expires_in > 0 ? expires_in : 3600 };
}
const needsRefresh = (a, now, marginMs) => !a.access_token || a.expires_at - now <= marginMs;
/**
 * The saved sign-in with an access token good for at least `marginMs` more, refreshing it when needed. `rejected`
 * is an access token the server just refused (a 401): it is refreshed even with time left, unless another process
 * has already replaced it. Throws SignInNeeded when there is no sign-in or the server refuses the refresh (the
 * saved tokens are cleared then), and ServerUnavailable when the server cannot be reached or fails.
 *
 * The refresh token rotates on every use, so two processes refreshing at once (the job and `status`, say) would
 * spend it twice and the loser would be signed out. Refreshes are therefore made under a lock file, and the saved
 * sign-in is read again once the lock is held.
 */
export async function freshAuth(paths, opts = {}) {
    const fetchFn = opts.fetch ?? fetch;
    const now = opts.now ?? Date.now;
    const marginMs = opts.marginMs ?? 120_000;
    const stale = (a) => (opts.rejected !== undefined ? a.access_token === opts.rejected : needsRefresh(a, now(), marginMs));
    const first = loadAuth(paths);
    if (!first || !first.refresh_token)
        throw new SignInNeeded("Not signed in.");
    if (!stale(first))
        return first;
    const lock = await waitForLock(paths.refreshLock);
    try {
        const auth = loadAuth(paths);
        if (!auth || !auth.refresh_token)
            throw new SignInNeeded("Not signed in.");
        if (!stale(auth))
            return auth;
        const { status, body } = await tokenRequest(fetchFn, auth.server, {
            grant_type: "refresh_token", refresh_token: auth.refresh_token, client_id: auth.client_id,
        });
        if (status === 200) {
            const t = tokensFrom(body);
            if (!t)
                throw new ServerUnavailable("Product Map answered the refresh without tokens.");
            const next = { ...auth, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now() + t.expires_in * 1000 };
            saveAuth(paths, next);
            return next;
        }
        if (status === 400 || status === 401) {
            // invalid_grant: the refresh token is spent or ended (disconnected in Product Map, or 30 days unused).
            // invalid_client: the server no longer knows this client, so the next sign-in registers a new one.
            const dropClient = body.error === "invalid_client";
            saveAuth(paths, { ...auth, client_id: dropClient ? "" : auth.client_id, access_token: null, refresh_token: null, expires_at: 0 });
            throw new SignInNeeded("Product Map refused to refresh the sign-in.");
        }
        throw new ServerUnavailable(`Product Map could not refresh the sign-in (HTTP ${status}).`);
    }
    finally {
        lock.release();
    }
}
/** The refresh lock, waiting up to 30 seconds for another process's refresh to finish (a refresh is one request). */
export async function waitForLock(path) {
    const until = Date.now() + 30_000;
    for (;;) {
        const lock = takeLock(path, { staleMs: 60_000 });
        if (lock)
            return lock;
        if (Date.now() > until)
            throw new ServerUnavailable("Another refresh of the sign-in is taking too long.");
        await new Promise((r) => setTimeout(r, 200));
    }
}
const CALLBACK_PATH = "/callback";
const PAGE = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product Map</title></head><body><p>${msg}</p></body></html>`;
function listen(port) {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.once("error", reject);
        s.listen(port, "127.0.0.1", () => resolve(s));
    });
}
/** The code the browser brings back to the loopback address, once the state matches. */
function waitForCode(server, state, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sign-in timed out: nothing came back from the browser.")), timeoutMs);
        server.once("close", () => { clearTimeout(timer); reject(new Error("Sign-in stopped.")); });
        server.on("request", (req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
                res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
                return;
            }
            if (url.searchParams.get("state") !== state) {
                res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE("This sign-in link does not match. Start again from the terminal."));
                return;
            }
            clearTimeout(timer);
            const error = url.searchParams.get("error");
            const code = url.searchParams.get("code");
            if (error || !code) {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Sign-in was not completed. You can close this tab."));
                const word = error && /^[a-z_]{1,40}$/.test(error) ? ` (${error})` : "";
                reject(new Error(`Sign-in was not completed${word}.`));
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE("Signed in. You can close this tab and go back to the terminal."));
            resolve(code);
        });
    });
}
async function registerClient(fetchFn, server, redirectUri) {
    let r;
    try {
        r = await fetchFn(endpoints(server).register, {
            ...FETCH_OPTIONS, signal: fetchSignal(),
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
                client_name: "Product Map agent inbox",
                redirect_uris: [redirectUri],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
            }),
        });
    }
    catch {
        throw new ServerUnavailable("Could not reach Product Map to register this machine.");
    }
    if (r.status === 429)
        throw new ServerUnavailable("Too many sign-ins from this address. Wait an hour and try again.");
    let body = {};
    try {
        body = (await r.json());
    }
    catch {
        body = {};
    }
    if (r.status !== 201 && r.status !== 200)
        throw new ServerUnavailable(`Product Map refused to register this machine (HTTP ${r.status}).`);
    if (typeof body.client_id !== "string" || !body.client_id)
        throw new ServerUnavailable("Product Map answered the registration without a client id.");
    return body.client_id;
}
export function authorizeUrl(server, clientId, redirectUri, challenge, state) {
    const u = new URL(endpoints(server).authorize);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("state", state);
    return u.toString();
}
/**
 * Signs in: reuses this machine's registered client when its loopback port is free, else registers a new one;
 * opens the consent page; waits for the code; exchanges it with the PKCE verifier; saves the tokens.
 */
export async function login(paths, server, deps) {
    const fetchFn = deps.fetch ?? fetch;
    const now = deps.now ?? Date.now;
    const prior = loadAuth(paths);
    let reuse = prior && prior.server === server && prior.client_id && prior.redirect_uri ? prior : null;
    let http = null;
    if (reuse) {
        try {
            http = await listen(Number(new URL(reuse.redirect_uri).port));
        }
        catch {
            http = null;
            reuse = null;
        }
    }
    if (!http)
        http = await listen(0);
    try {
        const port = http.address().port;
        const redirectUri = reuse ? reuse.redirect_uri : `http://127.0.0.1:${port}${CALLBACK_PATH}`;
        const clientId = reuse ? reuse.client_id : await registerClient(fetchFn, server, redirectUri);
        const verifier = newVerifier();
        const state = b64url(randomBytes(32));
        const url = authorizeUrl(server, clientId, redirectUri, challengeFor(verifier), state);
        const code = waitForCode(http, state, deps.timeoutMs ?? 5 * 60_000);
        code.catch(() => { });
        deps.print("Opening Product Map in your browser to sign in. If it does not open, visit:");
        deps.print(url);
        if (reuse)
            deps.print("If the page says the link is not valid, delete ~/.config/product-map/agent-inbox.json and sign in again.");
        try {
            deps.openBrowser(url);
        }
        catch { /* the address is printed above */ }
        const got = await code;
        // Under the refresh lock, so a tick refreshing the old sign-in at this moment cannot overwrite the new one.
        const lock = await waitForLock(paths.refreshLock);
        try {
            const { status, body } = await tokenRequest(fetchFn, server, {
                grant_type: "authorization_code", code: got, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
            });
            const t = status === 200 ? tokensFrom(body) : null;
            if (!t)
                throw new Error(`Product Map refused the sign-in (HTTP ${status}). Try again.`);
            const auth = {
                server, client_id: clientId, redirect_uri: redirectUri,
                access_token: t.access_token, refresh_token: t.refresh_token,
                expires_at: now() + t.expires_in * 1000, signed_in_at: new Date(now()).toISOString(),
            };
            saveAuth(paths, auth);
            return auth;
        }
        finally {
            lock.release();
        }
    }
    finally {
        http.close();
        http.closeAllConnections?.();
    }
}
/**
 * Signs out on this machine: the token file is deleted. Product Map's server offers no revocation endpoint, so the
 * connection itself ends only when the person disconnects it on the Connected agents page (or after 30 days unused).
 */
export async function logout(paths) {
    const lock = await waitForLock(paths.refreshLock);
    try {
        const had = loadAuth(paths) !== null;
        rmSync(paths.auth, { force: true });
        return had;
    }
    finally {
        lock.release();
    }
}
