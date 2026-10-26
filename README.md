# The Product Map plugin

Product Map in Claude Code: the connection to Product Map, the skills to capture, draft, plan and build its work, and the agent inbox that answers the requests you mark for your agent.

## Install

You need [Claude Code](https://claude.com/claude-code), Node 20 or later, a Product Map account, and read access to this repository on GitHub (it is private: ask for an invitation). In Claude Code:

```
/plugin marketplace add james-b-kelly/product-map-plugin
/plugin install product-map@product-map
```

Then:

1. Run `/mcp`, choose **product-map** and sign in. This is the connection the skills use.
2. Run `/product-map:setup`. It first says what the agent inbox is: a small program this plugin carries, which signs this machine in to Product Map, links a project's code, and, if you turn it on, answers requests for your agent in the background. Then it signs this machine in, asks your role in each project (Shape: you write, discuss and/or design the work; Build: everything in Shape, and your agent also picks up work units and writes code) and, for Build, whether your agent should answer requests in the background. If you set Product Map up before the plugin (skills such as `work-unit` in your own skills, a `product-map` server you added by hand, a background job run from a repo), it lists each one and asks whether to retire it (moved to `~/.product-map-inbox/retired/`, nothing deleted; a server's settings are saved there without its secrets) or keep it.

Run `/product-map:setup` again at any time, and after each update of the plugin: it keeps what is right, fixes what has drifted and says what it changed (or that nothing changed).

## Versions

The plugin tells Product Map its version, over each connection it uses, and the Connected agents page shows it beside the agent ("Plugin 0.2.0, reported 2h ago"). What changed in each version is in Product Map's own repository, `plugin/CHANGES.json`.

## What is in it

| | |
|---|---|
| `/product-map:setup` | Sets up this machine (above). |
| `/product-map:work-on <id>` | Where an entry, brief or unit stands, and the next step. With no id: what needs work. |
| `/product-map:capture <id>` | A summary of this session into an entry. |
| `/product-map:draft-brief <slug>` | Drafts a brief from its entries. |
| `/product-map:draft-plan <slug>` or `entry <id>` | Drafts a plan and its work units. |
| `/product-map:work-unit …` | Picks up a work unit and builds it (Build only), and marks it Done once its pull request is merged. |
| `agent-inbox` | Used by the background job to answer one request. Not for use by hand. |

## The way of working, and the claimed-unit check

The skills follow the way of working in `context/`: every request to build gets work in Product Map first, with as much process as it needs (one work unit; a plan once there are two or more; a brief when it needs sign-off). Under Shape, a request to build is captured as work for someone else.

The plugin's hooks (`hooks/hooks.json`; they need Node):

- In a repository linked to a project you build, a new branch (`git checkout -b`, `git switch -c`), worktree (`git worktree add`, or a new one from Claude Code's own) or pull request (`gh pr create`) is held back until the session has claimed a work unit there (`/product-map:work-unit`). To go ahead without one, once, tell your agent so: it runs the command again starting with `PRODUCT_MAP_SKIP_UNIT_CHECK=1`. After `/clear` or a resume, the agent picks the unit up again with the same session id, which returns it unchanged.
- **It is an advisory guard, not a security boundary.** It reads commands on a best-effort basis and fails open: a command it cannot read for sure (a folder or repository built from a variable, a script, `git branch`, `git push` to a new branch, `gh api`) goes through, and so does everything when the hook itself fails.
- A session started in a linked repository is given the way of working without running a skill first.
- A repository counts as linked when setup linked its folder for the inbox, or when Product Map's `list_repos` named it for the project in a session on this machine. Nothing is held back anywhere else, or under Shape.
- What the hooks remember (the unit each session claimed, each project's role and repositories) is kept in the plugin's data folder in `~/.claude/plugins/data/`. They never reach Product Map themselves, and if one fails, the command goes ahead.

The plugin's own copy of the inbox is in `inbox/`. Setup installs the background job from it (macOS only for now). See the inbox's README in the Product Map repository for everything it does.
