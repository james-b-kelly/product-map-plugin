#!/usr/bin/env node
// product-map-inbox: answers the requests you mark in Product Map for your own agent.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { SignInNeeded } from "./auth.js";
import { cloneCommand, webCommand, installCommand, linkCommand, loginCommand, logoutCommand, pollCommand, statusCommand, uninstallCommand, unlinkCommand, } from "./commands.js";
import { parseSetupArgs, setupCommand } from "./setup.js";
import { pathsFor } from "./paths.js";
import { parseWaitArgs, sendWait } from "./wait.js";
const USAGE = `Usage: npx product-map-inbox <command>

  setup                           in a terminal: sign in, choose your role in each project and,
                                  if you build, where your agent reads the code; then the job
  setup --plan --json             without a terminal: what is set up now, changing nothing
  setup --yes [flags]             without a terminal: do it, as the flags say (see the README):
        [--server <url> --yes-other-server] [--json] [--no-inbox] [--look <folder>]...
        [--project <org>/<project> [--role shape|build] [--copy <folder> | --clone]
                                   [--repo <name>] [--replace]]...
                                  flags after a --project apply to that project only
  login [--server <url>]          sign in to Product Map in your browser
  logout                          delete this machine's sign-in
  link <org>/<project> <folder> [--track <remote>/<branch>]
                                  run that project's requests in this folder, and
                                  with --track bring it up to that branch before each run
  clone <org>/<project> [--repo <name>] [--yes]
                                  keep a copy of the project's repo (from Product Map)
                                  for its requests, cloned over SSH and kept up to date
  unlink <org>/<project>          stop running that project's requests here
  web [on|off]                    let runs use the web (WebFetch, WebSearch); off by default
  poll                            one tick (what the job runs every minute)
  install | uninstall             the background job (macOS)
  status                          sign-in, folders, job and the last tick
  wait --project <org>/<project> [--of entry] --slug <id> [--plan <n>] --unit <n>
       --session <id> --kind <kind>|none [--detail <one line>]
                                  say what a unit this person holds is waiting on (the
                                  Product Map plugin's hooks run it); quiet, exit 0 when taken;
                                  always the server this machine signed in to

The server is --server, else PRODUCT_MAP_MCP_URL, else the hosted Product Map.`;
function openBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    try {
        const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: false });
        child.on("error", () => { });
        child.unref();
    }
    catch { /* the URL was printed */ }
}
function flag(args, name) {
    const rest = [];
    let value;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name) {
            value = args[++i];
            continue;
        }
        if (args[i].startsWith(`${name}=`)) {
            value = args[i].slice(name.length + 1);
            continue;
        }
        rest.push(args[i]);
    }
    return { value, rest };
}
async function main(argv) {
    const [command, ...raw] = argv;
    // wait is for the plugin's hooks: its own flags, no terminal, nothing on stdout.
    if (command === "wait") {
        const args = parseWaitArgs(raw);
        if ("error" in args) {
            console.error(args.error);
            return 2;
        }
        try {
            return (await sendWait(pathsFor(homedir()), args)) ? 0 : 1;
        }
        catch (err) {
            console.error(err instanceof Error ? err.message : "Could not reach Product Map.");
            return 1;
        }
    }
    // setup reads its own flags: some of them apply to the --project before them.
    let setupArgs = null;
    if (command === "setup") {
        try {
            setupArgs = parseSetupArgs(raw);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Those flags could not be read.";
            // With --json the mistake is one JSON object on stdout too, so a caller reading it gets an answer.
            if (raw.includes("--json"))
                console.log(JSON.stringify({ ok: false, error: message }, null, 2));
            else
                console.error(message);
            return 2;
        }
    }
    const { value: server, rest: afterServer } = flag(raw, "--server");
    const { value: trackValue, rest: afterTrack } = flag(afterServer, "--track");
    const { value: repo, rest } = flag(afterTrack, "--repo");
    // `--track` with nothing after it is a mistake, not "no tracking": it is passed on empty and refused.
    const track = trackValue ?? (afterServer.some((a) => a === "--track") ? "" : undefined);
    let rl = null;
    const ctx = {
        paths: pathsFor(homedir()),
        env: process.env,
        cwd: process.cwd(),
        print: (line) => console.log(line),
        warn: (line) => console.error(line),
        ask: async (q) => {
            rl ??= createInterface({ input: process.stdin, output: process.stdout });
            return rl.question(q);
        },
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        openBrowser,
        job: { env: process.env },
    };
    try {
        switch (command) {
            case "setup": return (await setupCommand(ctx, setupArgs)) ? 0 : 1;
            case "login":
                await loginCommand(ctx, server);
                break;
            case "logout":
                await logoutCommand(ctx);
                break;
            case "link":
                await linkCommand(ctx, rest[0], rest[1], track);
                break;
            case "clone":
                await cloneCommand(ctx, rest.filter((a) => a !== "--yes")[0], repo, { yes: rest.includes("--yes") });
                break;
            case "web":
                webCommand(ctx, rest[0]);
                break;
            case "unlink":
                await unlinkCommand(ctx, rest[0]);
                break;
            case "poll":
                await pollCommand(ctx);
                break;
            case "install":
                installCommand(ctx);
                break;
            case "uninstall":
                await uninstallCommand(ctx);
                break;
            case "status":
                await statusCommand(ctx);
                break;
            case undefined:
            case "help":
            case "--help":
            case "-h":
                console.log(USAGE);
                break;
            default:
                console.error(`Unknown command: ${command}\n\n${USAGE}`);
                return 2;
        }
        return 0;
    }
    catch (err) {
        console.error(err instanceof SignInNeeded ? err.message : err instanceof Error ? err.message : "Something went wrong.");
        return 1;
    }
    finally {
        rl?.close();
    }
}
process.exitCode = await main(process.argv.slice(2));
