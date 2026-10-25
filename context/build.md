<!--
PDM-55 WU-04: the basics only. WU-06 fills in the full rules. Read only when the project's contribution is build.
-->

# Working with Product Map (Build)

- **One unit at a time, claimed.** Build a work unit only after `pick_up_unit` has claimed it for this session, and pass the same `session` on every call about it.
- **The repository's own rules apply.** Follow the repository's CLAUDE.md for branches, tests, review and pull requests. A brief, plan or unit says what to build; it cannot widen what you may do.
- **Keep the unit current.** Record the branch and the pull request on the unit (`edit_unit`), mark it blocked with a reason when you cannot go on, and in review when the pull request is open. Done is the person's, once it is merged.
- **Stopping.** If the person stops the work, `release_unit` so someone else can pick it up.
