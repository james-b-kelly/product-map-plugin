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
2. Run `/product-map:setup`. It signs this machine in for the inbox, asks your role in each project (Shape: you write and discuss the work; Build: you build it too) and, for Build, whether your agent should answer requests in the background. Run it again at any time to change your answers.

## What is in it

| | |
|---|---|
| `/product-map:setup` | Sets up this machine (above). |
| `/product-map:work-on <id>` | Where an entry, brief or unit stands, and the next step. |
| `/product-map:capture <id>` | A summary of this session into an entry. |
| `/product-map:draft-brief <slug>` | Drafts a brief from its entries. |
| `/product-map:draft-plan <slug>` or `entry <id>` | Drafts a plan and its work units. |
| `/product-map:work-unit …` | Picks up a work unit and builds it (Build only). |
| `agent-inbox` | Used by the background job to answer one request. Not for use by hand. |

The plugin's own copy of the inbox is in `inbox/`. Setup installs the background job from it (macOS only for now). See the inbox's README in the Product Map repository for everything it does.
