> [!NOTE]
> Built locally with `Qwen 3.8 Flash Next Q4`, `llama.cpp`, and `pi`.
>
> `REQUIREMENTS.md` was used initially, and the tokens-per-second feature, `README.md`, and `.gitignore` were added afterwards.
>
> Only tested with `llama.cpp`. The tokens-per-second seems a bit lower than what's reported by `llama.cpp`.

# pi-stats

A [pi](https://pi.dev) extension that reports request timing, token throughput, and compaction counts for your coding sessions.

## What it shows

- **Status bar** — live elapsed time and tokens/sec while a response streams, then the last request duration, output rate, and compaction count:
  ```
   ⏱ 12.3s  ⚡ 84.5 tok/s  📦 2
  ```
- **Request-complete notification** — total duration, request count, compaction count, and output/total tokens with their tokens/sec rates.
- **`/stats` command** — on-demand breakdown:
  - Requests and compactions in the session
  - Last request duration and throughput
  - Current request progress and live rate (while running)
  - Session active time and session-wide throughput
  - Total session tokens (input / output, cache read / write)

Counts and token totals are reconstructed from session history on startup, so resumed sessions report meaningful numbers immediately.

## Install (local use)

From this directory:

```bash
pi install .
```

Or load it for a single run without touching settings:

```bash
pi -e .
```

Then start `pi` normally. Use `/stats` anytime to print the full report.

## Notes

- Written in TypeScript; Pi loads it directly via `jiti` — no build step.
