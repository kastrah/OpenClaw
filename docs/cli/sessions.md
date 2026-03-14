---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage) + `openclaw sessions health` (diagnose tool pairing issues)"
read_when:
  - You want to list stored sessions and see recent activity
  - You encounter "tool id not found" errors
---

# `openclaw sessions`

List stored conversation sessions.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --json
```

# `openclaw sessions health`

Diagnose session health for tool call/result pairing issues. Use this when you encounter errors like:

> `LLM request rejected: invalid params, tool result's tool id(call_function_xxx) not found`

This command checks for:

- **Orphaned tool results** - tool results without matching tool calls
- **Unmatched tool calls** - tool calls without results
- **Duplicate tool results** - multiple results for the same tool call

```bash
# Check all sessions for issues
openclaw sessions health

# Show detailed diagnostics for all sessions
openclaw sessions health --verbose

# Check a specific session by ID
openclaw sessions health --session-id d7ce8851-6c25-4244-b872-58690b546288

# Use a custom session store
openclaw sessions health --store /path/to/sessions.json
```

## Example output

**Healthy session:**

```
✅ [agent:main:main] HEALTHY (22 messages)
```

**Unhealthy session:**

```
❌ [agent:main:main] UNHEALTHY
  - Found 1 orphaned tool result(s) without matching tool call
  Orphaned IDs: call_function_ynavyw1i6p3e_1
```

## Troubleshooting

If a session is unhealthy:

1. Clear the session:

   ```bash
   rm -f ~/.openclaw/agents/*/sessions/*.jsonl
   ```

2. Restart the gateway:

   ```bash
   pkill -HUP openclaw-gateway
   ```

3. Verify health:
   ```bash
   openclaw sessions health --verbose
   ```

## Scope selection:

- default: configured default agent store
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

`openclaw sessions --all-agents` reads configured agent stores. Gateway and ACP
session discovery are broader: they also include disk-only stores found under
the default `agents/` root or a templated `session.store` root. Those
discovered stores must resolve to regular `sessions.json` files inside the
agent root; symlinks and out-of-root paths are skipped.

JSON examples:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-5" }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `openclaw sessions cleanup` maintains session stores/transcripts only. It does not prune cron run logs (`cron/runs/<jobId>.jsonl`), which are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--active-key <key>`: protect a specific active key from disk-budget eviction.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

Related:

- Session config: [Configuration reference](/gateway/configuration-reference#session)
