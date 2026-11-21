---
name: loom
description: Keep the user's Loom up to date while you work in a git project - register the plan you are carrying out, move its steps as you go, put your branch on it, report what blocks you - and use Loom's view of the repository (branches, worktrees, plans) and its git actions. Use whenever you start, continue or finish multi-step work in a repository that is a Loom project, when the user mentions Loom, a plan or an idea for later, or asks where work stands.
---

# Loom

Loom is the user's project screen in Thoth: each project is a git repository,
shown as a commit graph with every branch and worktree, and a board of
**plans** — rough **ideas** for later, and exact plans with **steps** that an
agent is working through. The user watches it to see who does what, where, and
how far it got, without asking. Keeping it true is part of the work.

The `loom` MCP server gives you the same things the screen has. Plans are
Markdown pages in the user's Notes vault (`Loom/<project>/Plans/`), so they can
also be read and edited there.

## Join first

Once per session, before changing plans: `loom_join` with your **name** (the
one the user calls you; the same name later is the same agent, so plans and
questions find you again), your **session** id (the listener-mcp agent id from
your session context, `claude:…` or `codex:…`), and the projects you work on
(default: the one your working folder is in). Your changes are then signed with
your name, and the user's **Ask** reaches you: in Agent Chat when you are
attached to a chat session, otherwise as a question in Loom's inbox.

`loom_join` returns the questions waiting for you. Answer each with
`loom_inbox` (`answer: { id, text }`); the answer shows on the plan. Check
`loom_inbox` again when you finish a step.

## The project

Tools take `project` (id, name or folder); left out, it is the project your
working folder is in. `loom_projects` shows them and which one is yours. A
repository that is not in Loom yet: `loom_project_add` only if the user wants
it tracked.

## Working through a plan

1. **Before starting** multi-step work, look for its plan: `loom_plans`
   (filter by `branch` or `status`). Found one: continue it. None: create it
   with `loom_plan_create` — a clear title, a short description of the goal,
   the steps in order, and the branch if there is one. A plan with steps is
   yours (`agent`) unless you say otherwise.
2. **Branch.** When the work gets a branch or a worktree, put it on the plan:
   `loom_plan_update` with `branch`. The graph then shows the plan on it.
3. **Steps.** `loom_step` with `state: "running"` when you start a step,
   `"done"` when it is finished — as you go, not all at the end. A step that
   turns out to be several: `loom_steps_add`. A step you drop: `"skipped"`.
4. **Blocked.** When you wait on the user or anything else, mark the step
   `"blocked"` with a `note` saying exactly what you need. The plan turns
   Blocked on the user's board. When it moves again, set the step `"running"`.
5. **Notes.** Decisions and findings worth keeping go under their step as a
   `note` (Markdown), briefly.
6. **Finish.** The last step done finishes the plan. If the work stops
   unfinished, leave the plan as it is with an accurate stage, or move it to
   `Queued`/`Dropped` with `loom_plan_update`, and say why in a note.

Never leave a running plan without a stage: the board is how the user sees
where things stand.

## Ideas

A rough thought for later — the user's or yours, when the user agrees — is an
**Idea**: `loom_plan_create` without steps. Ideas don't belong to a version or
a branch. When one gets worked out, add steps and move it to `Queued`.

## The repository

- `loom_status`: the checked-out branch, worktree state, branches with
  ahead/behind, worktrees, recent commits and the unfinished plans. Read it
  before switching branches or merging.
- `loom_git`: checkout, branch, delete_branch, merge, abort_merge, fetch,
  pull, push — what the user does from the graph. It refuses with a reason
  when uncommitted changes would be lost; a merge with conflicts stops and
  lists them: resolve and commit, or `abort_merge`. Plain `git` in a terminal
  is fine too; Loom follows the repository either way.
- Destructive or shared changes (force-deleting a branch, pushing) only when
  the work calls for them or the user asked.
