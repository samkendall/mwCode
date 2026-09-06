# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory.

## Start a thread

On web and desktop, a new thread keeps the current project and carries your model
and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.

When you change a new thread's project, T3 Code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start in the background

In a desktop browser or the desktop app, press `Cmd+Enter` on macOS or `Ctrl+Enter`
on Windows and Linux to start a new thread and immediately open another draft. The
next draft keeps the workspace mode and base branch you selected. With **New
worktree**, each background submission creates its own worktree.

## Pin and reorder threads

Pin a thread from its menu to keep it above your active work. Drag pinned threads
to reorder them on web and desktop, or use **Move up** and **Move down** on mobile.
The order syncs across devices.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

## Shape the list

**Settings → General → Sidebar density** controls how much each row shows.
**Cozy** is the default, a two-line row. **Comfortable** keeps the taller cards
for pinned and active threads. **Compact** puts every row on a single line,
including pinned, active, and draft rows; it keeps the title, the status, the
pull request badge, and the provider icon, and moves the project name and branch
to the row's hover card.

**Group threads** puts your active threads under headings — by **Project**,
**Work type**, or **Stage**. It is **Off** by default. Pinned, snoozed, and
settled threads stay in one list either way, and keyboard jump shortcuts follow
the list as you see it. Grouping by project gives each heading the project's icon
and thread count; a repository you have open in more than one environment appears
under a single heading. Drag a project heading on web and desktop to reorder the
groups.

**Sort threads** sets the default order for active threads. **Default** keeps the
static order; the other modes surface threads needing your attention, cluster by
work type, or float threads with a pull request to the top. When you group by
project, each heading has its own sort control that overrides the default for
that project; choosing **Default** there returns it to your global setting. See
[work type and stage options](./harness-taxonomy.md) to change the labels these
modes group and sort by.

## Settle finished work

Choose **Settle thread** from its menu to move finished work out of the active list
without deleting the conversation. **Un-settle thread** restores it to active work
and prevents automatic settlement until new activity resumes the usual rules.

By default, environments settle inactive threads after three days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. Work in progress, pending questions or approvals, and live background work
prevent automatic settlement. An open pull request does not prevent inactivity
settlement, but an old closed or merged pull request does not settle work you
resumed after it closed.

Change these rules in **Settings → General**. They continue to run when your apps
are closed. Changes apply to connected environments that support shared settings;
offline environments and older servers keep their previous values. If connected
environments disagree, **Apply to all** copies your current settings to those named
in the warning. Changing a rule does not reopen already settled threads.

## Link a pull request

On web and desktop, right-click a pull request link in a thread and choose
**Link to thread**. Use **Unlink from thread** on the same link to remove it.
The linked pull request participates in automatic settlement.

## Find and reference work

On web and desktop, open the command palette with `Cmd/Ctrl+K` to search threads
across connected environments. Message search starts after two characters and
includes your messages and final agent responses.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise its thread ID. See [keybindings](./keybindings.md)
for custom configuration.

## Inspect agent work

On web and desktop, use **Agents** to follow work delegated to subagents.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.
