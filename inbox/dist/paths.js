// Every file the package reads or writes, from one home folder, so the tests can point all of it at a temp dir.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
/** The package's own folder (the parent of dist/ or src/). */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LABEL = "com.productmap.agent-inbox";
export const DEFAULT_SERVER = "https://hlgeoebmigivjtbwaaup.supabase.co/functions/v1/mcp";
/** The environment variable that names another server (the `--server` flag wins over it). */
export const SERVER_ENV = "PRODUCT_MAP_MCP_URL";
export function pathsFor(home) {
    const configDir = join(home, ".config", "product-map");
    const skillDir = join(home, ".claude", "skills", "agent-inbox");
    return {
        home,
        configDir,
        auth: join(configDir, "agent-inbox.json"),
        folders: join(configDir, "agent-inbox-folders.json"),
        state: join(configDir, "agent-inbox-state.json"),
        lock: join(configDir, "agent-inbox.lock"),
        refreshLock: join(configDir, "agent-inbox-refresh.lock"),
        runMcpConfig: join(configDir, "agent-inbox-run-mcp.json"),
        runSettings: join(configDir, "agent-inbox-run-settings.json"),
        runPrompt: join(configDir, "agent-inbox-run-prompt.md"),
        appDir: join(configDir, "agent-inbox-app"),
        skillDir,
        skill: join(skillDir, "SKILL.md"),
        launchAgents: join(home, "Library", "LaunchAgents"),
        plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`),
        log: join(home, "Library", "Logs", "product-map-agent-inbox.log"),
        reposDir: join(home, ".product-map-inbox", "repos"),
        knownHosts: join(configDir, "github_known_hosts"),
        settings: join(configDir, "agent-inbox-settings.json"),
        retiredDir: join(home, ".product-map-inbox", "retired"),
        userSkills: join(home, ".claude", "skills"),
        claudeJson: join(home, ".claude.json"),
    };
}
/** The server address: the flag, then the environment variable, then the hosted server. No trailing slash. */
export function serverFrom(flag, env) {
    const raw = (flag ?? env[SERVER_ENV] ?? "").trim() || DEFAULT_SERVER;
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new Error(`That is not a server address: ${raw}`);
    }
    const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("The server address must be https (or http on this machine).");
    }
    return url.toString().replace(/\/+$/, "");
}
