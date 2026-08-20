# pi-ask-user-question-lite

A minimal [`AskUserQuestion`](https://docs.anthropic.com/en/docs/claude-code) tool for [Pi Coding Agent](https://pi.dev). It lets an agent pause, ask a structured question, and continue with the user's explicit choice.

**Built with [Pi Coding Agent](https://pi.dev).**

## Features

- One question or 1–4 sequential questions per call
- 2–4 described options per question
- Single-select and multi-select
- Automatic free-text `Other` choice for single-select
- One persistent TUI across multi-question flows, avoiding transition flicker
- Compact `Question 1/N` progress
- Native RPC `select` and `input` dialogs
- Non-blocking JSON/print fallback
- No human-response timeout
- Sequential tool execution so dialogs never overlap
- No bundled skill, workflow, or system-prompt policy

## Install

```bash
pi install npm:@haichiu/pi-ask-user-question-lite
```

Or install directly from GitHub:

```bash
pi install git:github.com/haichiu/pi-ask-user-question-lite
```

For local development:

```bash
pi -e ./extensions/index.ts
```

Restart Pi or run `/reload` after installation.

## Tool

The package registers one model-callable tool:

```text
AskUserQuestion
```

Example input:

```json
{
  "questions": [
    {
      "header": "Database",
      "question": "Which database should we use?",
      "options": [
        { "label": "PostgreSQL", "description": "Strong relational features." },
        { "label": "SQLite", "description": "Small and dependency-free." }
      ]
    },
    {
      "header": "Features",
      "question": "Which optional features should be enabled?",
      "multiSelect": true,
      "options": [
        { "label": "Backups" },
        { "label": "Metrics" }
      ]
    }
  ]
}
```

## Mode behavior

| Mode | Behavior |
| --- | --- |
| TUI | Persistent keyboard-driven selector with inline free-text editing |
| RPC | Native `select`/`input` requests |
| JSON / print | Immediate plain-text fallback; never blocks waiting for unavailable UI |

Escape cancels normally and returns a successful tool result with a null answer.

<details>
<summary>Compatibility notes</summary>

Pi Fabric users who capture extension tools may optionally keep this human-interaction tool directly visible so it does not inherit a machine-execution timeout:

```json
{
  "capture": {
    "keepVisible": ["fabric_exec", "AskUserQuestion"]
  }
}
```

This is a Fabric-specific host setting, not a requirement of the package.

</details>

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## Attribution

Adapted from [`ilovepixelart/pi-code`](https://github.com/ilovepixelart/pi-code), which is based on Pi's MIT-licensed question example. See [`LICENSE`](LICENSE).

## License

MIT
