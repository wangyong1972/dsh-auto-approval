# dsh-auto-approval

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Cordis plugin that automatically approves safe permission requests using a local LLM (via [LM Studio](https://lmstudio.ai)), so you are only prompted for genuinely ambiguous or risky operations.

It listens on the `approval/request` waterfall event **ahead of** the built-in UI answerer (via `prepend`), decides each request through a layered defense, defers uncertain or denied-list operations to the human, and **learns** operations you approve so they are auto-approved in the future.

## How it works

```
Permission request (sandbox escalation, tool approval)
        │
        ▼
┌───────────────────────────────────────────────┐
│ 0. Danger patterns (destructive commands)     │
│    match → always defer to human (never       │
│    overridden by learning or the LLM)         │
└───────────────────────────────────────────────┘
        │ no match
        ▼
┌───────────────────────────────────────────────┐
│ 1. Learned patterns (you approved before)     │
│    match → allowed-once (no LLM, ~6ms)        │
└───────────────────────────────────────────────┘
        │ no match
        ▼
┌───────────────────────────────────────────────┐
│ 2. Quick-path allow-list (glob match)         │
│    session workspace root + allowedPatterns   │
│    match → allowed-once (no LLM call)         │
└───────────────────────────────────────────────┘
        │ no match
        ▼
┌───────────────────────────────────────────────┐
│ 3. Local LLM judge (LM Studio)                │
│    strict two-value verdict (approve|ask)     │
│    approve → allowed-once                     │
│    ask / timeout / malformed / error          │
│      → defer to human prompt                  │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 4. Human decides                              │
│    approve → operation runs AND the target    │
│              is learned into the pattern file │
│              (future matches auto-approve)    │
│    reject  → operation blocked, nothing       │
│              is learned                       │
└───────────────────────────────────────────────┘
```

Key behaviors:

- **The deny-list never silently rejects.** A deny-list hit (e.g. `.ssh/`, `/etc/`) is deferred to the human prompt, so you always keep the final say. The operation only runs if you approve it.
- **Learning is opt-in.** Set `patternFile` to enable it. Every operation you approve after the plugin deferred is remembered; a future identical or pattern-matching operation is auto-approved without prompting or an LLM call.
- **Only human approvals are learned.** Operations the plugin auto-approved (allow-list or LLM-safe) are not learned — there is nothing to learn, and the pattern file only grows from your explicit decisions.
- **Safe by default on errors.** If LM Studio is unreachable or returns a malformed response, the request is deferred to the human prompt.
- **Danger patterns always defer to the human.** A deterministic regex list (built-in + `extraDangerPatterns`) is checked *before* learned patterns, so a one-time approval of a destructive command (e.g. `rm -rf /`, `dd`, `git push --force`) can never become a permanent exemption.
- **No restart needed for config changes** — the profile patch is watched by DSH's HMR. Restart is only required after *code* changes to the plugin itself.
- **Toggle at runtime with `/autoapprove on|off|status`** — no restart, no YAML editing. See [Runtime on/off](#runtime-onoff).

## Prerequisites

- A running DSH profile (tested with the `web` profile).
- [LM Studio](https://lmstudio.ai) serving an OpenAI-compatible endpoint with a small instruction-tuned model loaded (see [Model recommendations](#model-recommendations)).
- Node.js `^22.19.0 || >=24.0.0` and `pnpm`.

## Installation

### 0. Clone and build

```sh
git clone https://github.com/<you>/dsh-auto-approval.git
cd dsh-auto-approval
pnpm install
pnpm run build        # compiles src/ → lib/
```

The `lib/` output is git-ignored, so a fresh clone must build before use.

### 1. Install into your profile

```sh
dsh plugin --profile web add /path/to/dsh-auto-approval
```

This adds the plugin as a `link:` dependency in `~/.dsh/profiles/web/package.json`.

### 2. Enable it via the profile patch

Edit `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: auto-approval
      name: 'dsh-auto-approval'
      config:
        patternFile: /Users/you/.dsh/auto-approval-patterns.json
```

If DSH is already running, the patch watcher (HMR) picks the change up automatically. Otherwise restart DSH.

### 3. Restart DSH (only for code changes)

```sh
npx @deepseek-ai/dsh web --host 127.0.0.1 --port 3080
```

You should see:

```
[auto-approval] Active (state=on, model=gemma-4-e4b-it-mlx, threshold=0.7, patterns=/Users/you/.dsh/auto-approval-patterns.json, danger=13 rules, stateFile=/Users/you/.dsh/auto-approval-state.json)
```

When a human approves a deferred operation, the terminal logs:

```
[auto-approval] learned pattern for bash: echo "..." > /Users/you/...
```

## Configuration

All options are optional; defaults are shown.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | `http://127.0.0.1:1234/v1` | LM Studio OpenAI-compatible API base URL |
| `modelName` | `string` | `gemma-4-e4b-it-mlx` | Model id exactly as served by LM Studio |
| `allowedPatterns` | `string[]` | `['$WORKSPACE/**']` | Glob patterns always allowed (bypass LLM). The session's workspace root (`session.header.cwd`, the project directory the session was created in) is always included implicitly. |
| `deniedPatterns` | `string[]` | see below | Glob patterns that skip the LLM and go straight to the human prompt |
| `confidenceThreshold` | `number` | `0.7` | Minimum LLM confidence to auto-approve a `SAFE` verdict |
| `patternFile` | `string` | `''` (disabled) | Path to the learned-patterns JSON file. Enables learning. |
| `stateFile` | `string` | derived (see below) | Path to the on/off switch file toggled by `/autoapprove`. Defaults to `auto-approval-state.json` next to `patternFile`, or `~/.dsh/auto-approval-state.json` when no pattern file is set. |
| `auditFile` | `string` | `~/.dsh/auto-approval-audit.jsonl` | Path to the audit trail (every auto-approval, with basis). Empty derives the default. |
| `dangerPatterns` | `string[] \| null` | `null` (built-in list) | Case-insensitive regex sources that **replace** the built-in danger list |
| `extraDangerPatterns` | `string[]` | `[]` | Case-insensitive regex sources **appended** to the built-in danger list |
| `timeoutMs` | `number` | `8000` | End-to-end LLM classification deadline; a timeout defers to the human |

Default `deniedPatterns`:

```yaml
- '**/.ssh/**'
- '**/etc/shadow'
- '**/etc/passwd'
- '**/.gitconfig'
- '**/.aws/**'
- '**/.kube/**'
```

> **Note:** the deny-list is intentionally conservative. Extend it for your deployment, e.g. `'**/etc/**'`, `'**/root/**'`, `'**/.gnupg/**'`. Remember: deny-list hits are deferred to you, not auto-rejected, so a broad deny-list only means "always ask about these" — it never blocks you from approving.

### Overriding via `cordis.patch.yml`

```yaml
- id: auto-approval
  config:
    baseUrl: http://127.0.0.1:1234/v1
    modelName: gemma-4-e4b-it-mlx
    confidenceThreshold: 0.8
    allowedPatterns:
      - "$WORKSPACE/**"
    deniedPatterns:
      - "**/.ssh/**"
      - "**/etc/**"
      - "**/.aws/**"
    patternFile: /Users/you/.dsh/auto-approval-patterns.json
```

> Patch semantics: the `config` block **replaces** the whole plugin config, so list every option you want (defaults do not merge with your patch — they only apply when the field is omitted at the schema level, and a patch replaces the row's entire config).

## Runtime on/off

Toggle auto-approval at runtime from the chat UI — **no restart, no YAML editing**:

```
/autoapprove on       # auto-approve safe requests again
/autoapprove off      # every request goes to the human approval UI
/autoapprove status   # show the current state
/autoapprove stats    # audit roll-up: how many manual approvals were saved
```

How it works:

- When **off**, the plugin is inert: every `approval/request` passes straight through to the built-in human approval flow — exactly as if the plugin were not loaded. Nothing is learned while off.
- The switch is **persisted** to `stateFile` (default: `auto-approval-state.json` next to the pattern file, or `~/.dsh/auto-approval-state.json`), so a DSH restart does not silently re-enable auto-approval after you turned it off.
- The toggle is a plugin-internal switch, **not** an edit of `cordis.patch.yml`: it needs no config reload and cannot break the profile with a YAML mistake.

> Why not just comment out the plugin block in `cordis.patch.yml`? The patch watcher would technically pick that up (it recomposes the whole entry tree), but it is fragile: one YAML typo or a mid-session reload can disturb other plugins, and re-enabling requires re-adding the exact block. The command achieves the same "plugin inert" semantics instantly and safely.

## Audit trail

Every request the plugin **auto-approves** is appended as one JSON line to the audit file (`~/.dsh/auto-approval-audit.jsonl` by default, override with `auditFile`), recording the timestamp, tool, extracted target, and the **basis** for the decision:

| basis | Meaning |
|-------|---------|
| `learned` | Matched a pattern you approved before (no LLM call) |
| `allow` | Matched the allow-list (session workspace / `allowedPatterns`) |
| `judge` | The local LLM classified it `approve` (latency recorded) |

Deferred requests (danger match, deny-list, judge `ask`) are **not** recorded — those are the ones that still reach you. The file is trimmed at ~1 MB (keeps the newest 2000 lines). `/autoapprove stats` reads it and shows:

```
auto-approval: ON — audit total=42, today=7
  basis: learned=30  allow=8  judge=4
  latest:
    12:03:04 bash learned: echo ** > /Users/you/Desktop/fix.txt ...
```

The authoritative audit remains DSH's own `approval/asked` + `approval/decided` session events; this file is a convenience roll-up of what the plugin saved you from reviewing.

## Learned patterns file

When `patternFile` is set, the plugin maintains a JSON file like:

```json
{
  "bash": [
    {
      "pattern": "echo \"hi\" > /Users/you/Desktop/test.txt 2>&1",
      "count": 1,
      "lastApprovedAt": "2026-08-15T23:29:30.457Z"
    }
  ]
}
```

- `pattern` is the learned target for the operation you approved.
- **bash patterns are stored as a normalized *skeleton*.** The content of every quoted token (`"..."` / `'...'`) is replaced with `**`, so future requests that differ only in quoted wording match the same learned pattern — e.g. approving `echo "写入成功" > /path` also covers `echo "写入完成" > /path`. Matching is *strict*: the two skeletons must be string-equal, so structural differences (extra commands, different paths, different numbers of quotes) never match, and a trailing placeholder cannot swallow appended command segments (`... || echo "x" && ls` does **not** match a pattern ending in `... || echo **`). Quoted content is the only thing that may vary.
- **Command substitutions and backticks are never generalized.** `$()` and `` ` `` content is left verbatim, because it can carry executable content.
- **fs tools (edit/write) are stored verbatim** as exact file paths; fuzzy path matching is deliberately not applied.
- For entries learned before this feature (verbatim text), the same fuzzy matching applies via skeleton equality, so old patterns immediately match new wording too. Entries whose pattern contains a real `*`/`?` wildcard (no `**`) still match with glob semantics.
- The danger-pattern check runs **before** learned patterns, so a learned skeleton can never auto-approve a destructive command.
- `count` increments each time you approve a new occurrence of that pattern; auto-approvals via a learned pattern do **not** increment it.
- The list is capped at 50 entries per tool; the newest approvals win.
- You can edit or delete this file at any time — the plugin reloads it on the next request and on restart.
- Glob details: `*` matches within one path segment, `**` crosses segments, `?` matches one character; all other characters (including shell metacharacters like `|`, `&`, quotes, parentheses) match **literally** — they are escaped before regex compilation, so a pattern containing `||` never becomes a regex alternation and cannot match unrelated commands.

## Workspace root

The allow-list roots at the **session workspace** (`session.header.cwd`), which is the project directory the session was created in — not the DSH process's working directory. This matters because the DSH process often starts from the home directory; using `process.cwd()` would widen the allow-list to the whole home tree and silently auto-approve every write under it. With the session root, only writes under the actual project directory are allow-listed; writes anywhere else (e.g. `~/Desktop`, `~/Documents`) go through the LLM judge or the human prompt.

## Model recommendations

The judge is a deliberately small classification task (`SAFE` or `NOT_SAFE`). Tested outcomes:

| Model | Result |
|-------|--------|
| **Gemma 4 4B (`gemma-4-e4b-it-mlx`)** | ✅ Recommended. ~95% accuracy (21/22) with few-shot prompt, ~200ms latency |
| Qwen 2.5 1.5B (`qwen2.5-1.5b-instruct-mlx`) | ⚠️ 85% — struggles to recognize `.ssh/` as sensitive |
| Llama 3.2 1B | ❌ Too small, misclassifies sensitive paths |
| Qwen 3.5 2B | ❌ Reasoning model, burns all tokens thinking without emitting output |

Model choice notes:

- Prefer an **instruction-tuned, non-reasoning** model around 1.5B–4B parameters.
- Gemma outputs `NOT\_SAFE` (markdown-escaped underscore); the parser normalizes this.
- Set `modelName` to the exact id shown by `GET /v1/models`.

## Development

```sh
pnpm install
pnpm run build     # tsc → lib/
```

Source layout:

```
src/
├── index.ts        # Plugin entry: Config schema, apply(), approval/request listener, learning, /autoapprove command
├── judge.ts        # LM Studio call + few-shot prompt + strict two-value verdict parser
├── quick-check.ts  # Deny/allow glob fast-path (no LLM call)
├── patterns.ts     # Learned-pattern persistence + matching
├── state.ts        # Runtime on/off switch persistence (/autoapprove)
├── danger-patterns.ts  # Built-in danger-command regexes + compile/match
└── types.ts        # Config / JudgeVerdict / ToolCallEvent types + DEFAULTS
```

### Plugin authoring notes (why this looks the way it does)

- **Function plugins must NOT have a `default` export.** Mixing export forms makes the Cordis loader discard the plugin's namespace, so `config` arrives `undefined` at `apply()`.
- **`Config` must be a schemastery `z.object` schema**, not a plain object, or the loader passes `undefined` config.
- **Register with `{ prepend: true }`.** `approval/request` is a waterfall event; the apiproxy UI answerer is registered earlier and consumes requests without calling `next()`, so a listener appended later never sees them.
- **Match only the extracted target, not the raw JSON arguments.** The raw arguments include the file `content`, which may mention deny keywords (`.ssh`, `/etc/`) and falsely trigger the deny-list.
- Tool arguments are recovered from the session log by matching `callId` against `tool/call` events, because `ApprovalRequest` deliberately omits tool arguments.
- **Learning correlates approvals through `approval/decided`.** The plugin records which approvals it deferred, listens to `session/event`, and learns a target only when the outcome is `allowed-once` from a human decision.

## Troubleshooting

**Plugin loads but never intercepts (every request prompts).**
Restart DSH after code changes — the patch HMR watcher re-runs config composition but does not re-import changed plugin code (`diff.includes("name")` gates the re-import).

**`config` is `undefined` at `apply()`.**
The plugin must export `name` / `Config` / `apply` as named exports with **no `default` export**, and `Config` must be a schemastery schema.

**Safe writes get silently rejected.**
You are running an older build where deny-list hits returned `rejected`. Rebuild with the current source: deny-list hits now defer to the human prompt.

**A legitimate write was auto-rejected because the content mentioned `.ssh`/`/etc/`.**
Older builds matched the whole JSON arguments (including file content) against the deny-list. Rebuild with the current source, which matches only the extracted `file_path` or command.

**LM Studio not reachable.**
Requests are deferred to the human prompt (fail-open). Check `curl http://<host>:1234/v1/models`.

**Wrong model name.**
List served models with `curl http://<host>:1234/v1/models` and set `modelName` exactly.

**Learning not working.**
Make sure `patternFile` is set in the plugin config. Without it, learning is disabled and the plugin never defers-learns.

## License

MIT
