# Work type and stage options

> This is a fork feature. It may not be present in every build of T3 Code.

Each thread can carry two optional labels: a **work type** (what kind of change it is — a feature, a bug, a tweak) and a **stage** (where it sits in your workflow — planning, building, and so on). The options you can pick from, along with their labels and colors, are yours to configure.

The built-in set covers common cases, so you can use work type and stage without setting anything up. Edit the configuration only when you want different options, labels, or colors.

## Where the options live

Options come from two files, both named `harness.json`:

- **Global** — `~/.mwcode/harness.json`. Applies everywhere.
- **Per project** — `<project>/.mwcode/harness.json`, in the project's own folder. Applies to that project only, on top of the global set.

Each file has two lists, `workTypes` and `stages`. Every entry has a stable `id` (what gets stored on the thread), a `label` shown in the app, an optional `color`, and an optional `description` hint.

## Example

```json
{
  "workTypes": [
    {
      "id": "bug",
      "label": "Defect",
      "color": "#ef4444",
      "description": "Fixing broken behavior."
    },
    { "id": "chore", "label": "Chore", "color": "#64748b", "description": "Routine maintenance." }
  ],
  "stages": [{ "id": "shipping", "label": "Shipping", "color": "#22c55e" }]
}
```

## How your options combine

Your files layer on top of the built-in set, matched by `id`:

- An entry with a **new** id is added to the list.
- An entry whose id **matches** a built-in one replaces its label, color, and hint.
- Built-in entries you do not mention stay as they are.

So the example above renames the built-in `bug` to "Defect", adds a new `chore` work type and a `shipping` stage, and leaves everything else untouched. A per-project file layers the same way on top of your global set, for that project only.

The options are read when T3 Code starts. Edit a file, then restart the server to pick up the change. If a file has a typo or an invalid entry, T3 Code ignores that file and keeps the options from the layer below it, so a bad edit never breaks the app.
