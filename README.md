# dsh-auto-approval

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Cordis plugin that automatically approves safe permission requests using a local LLM (via [LM Studio](https://lmstudio.ai)), so you are only prompted for genuinely ambiguous or risky operations.

It listens on the `approval/request` waterfall event **ahead of** the built-in UI answerer (via `prepend`), decides each request through a layered defense, defers uncertain or denied-list operations to the human, and **learns** operations you approve so they are auto-approved in the future.

## How it works

```
Permission request (sandbox escalation, tool approval)
        │
        ▼
┌───────────────────────────────────────────────┐
│ 0. Learned patterns (you approved before)     │
│    match → allowed-once (no LLM, ~6ms)        │
└───────────────────────────────────────────────┘
        │ no match
        ▼
┌───────────────────────────────────────────────┐
│ 1. Quick-path allow-list (glob match)         │
│    session workspace root + allowedPatterns   │
│    match → allowed-once (no LLM call)         │
└───────────────────────────────────────────────┘
        │ no match
        ▼
┌───────────────────────────────────────────────┐
│ 2. Local LLM judge (LM Studio)                │
│    few-shot SAFE / NOT_SAFE classify          │
│    safe + confidence ≥ threshold              │
│      → allowed-once                           │
│    otherwise (unsafe / unsure / error)        │
│      → defer to human prompt                  │
└───────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────┐
│ 3. Human decides                              │
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
- **No restart needed for config changes** — the profile patch is watched by DSH's HMR. Restart is only required after *code* changes to the plugin itself.

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
[auto-approval] Active (model=gemma-4-e4b-it-mlx, threshold=0.7, workspace=/Users/you, patterns=/Users/you/.dsh/auto-approval-patterns.json)
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

- `pattern` is the **exact extracted target** (the bash command, or the `file_path` for fs tools) that you approved.
- `count` increments each time you approve a new occurrence of that pattern; auto-approvals via a learned pattern do **not** increment it.
- The list is capped at 50 entries per tool; the newest approvals win.
- You can edit or delete this file at any time — the plugin reloads it on the next request and on restart.
- **Matching is literal except `*` and `?`.** The pattern is treated as a glob: `*` matches within one path segment, `**` crosses directories, `?` matches one character. All other characters (including shell metacharacters like `|`, `&`, quotes, parentheses) match **literally** — they are escaped before regex compilation, so a pattern containing `||` never becomes a regex alternation and cannot match unrelated commands. A learned bash command only auto-approves a request whose extracted command is textually identical (up to glob wildcards).

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
├── index.ts        # Plugin entry: Config schema, apply(), approval/request listener, learning
├── judge.ts        # LM Studio call + few-shot prompt + SAFE/NOT_SAFE parser
├── quick-check.ts  # Deny/allow glob fast-path (no LLM call)
├── patterns.ts     # Learned-pattern persistence + matching
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
