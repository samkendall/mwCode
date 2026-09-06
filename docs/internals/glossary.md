# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Thread classification

Fork-local. Both labels are optional, nullable non-empty strings on the thread, set only after the
first turn through `thread.meta.update`; null clears them. The wire shape stays unconstrained — the
allowed ids and their display metadata come from the taxonomy.

| Term             | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| Work type        | What kind of change a thread is, such as a feature or a bug.                            |
| Stage            | Where a thread sits in a workflow, such as planning or building.                        |
| Harness taxonomy | The configurable vocabulary of allowed work type and stage ids, with labels and colors. |

The taxonomy is defined in [the contracts](../../packages/contracts/src/harnessTaxonomy.ts) as
`HarnessTaxonomy`, seeded by `DEFAULT_HARNESS_TAXONOMY`, and loaded server-side from a global
`<baseDir>/harness.json` and a per-project `<workspaceRoot>/.mwcode/harness.json`, each merged over
the defaults by id. Entries may also carry a one-line hint usable as an LLM classification cue. The
effective global set rides on the server-config snapshot so clients render labels and colors without
a request. It loads at config-load time with no hot reload; a malformed or invalid file logs a
warning and falls back to the layer below. User-facing setup lives in
[work type and stage options](../user/harness-taxonomy.md).

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |
