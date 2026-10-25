// The agent-inbox skill, copied to ~/.claude/skills/agent-inbox/SKILL.md (user level), replacing an older copy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./paths.js";
export const SKILL_SOURCE = join(PACKAGE_ROOT, "skill", "SKILL.md");
export function installSkill(paths, source = SKILL_SOURCE) {
    const text = readFileSync(source, "utf8");
    let before = null;
    try {
        before = readFileSync(paths.skill, "utf8");
    }
    catch {
        before = null;
    }
    if (before === text)
        return "unchanged";
    mkdirSync(paths.skillDir, { recursive: true });
    writeFileSync(paths.skill, text, { mode: 0o644 });
    return before === null ? "installed" : "updated";
}
