/**
 * Pi Stat Plugin
 *
 * Shows the total time it took to run each request, the tokens it consumed,
 * the resulting tokens/second throughput, and how many compactions have
 * occurred in the current session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

function createTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function usageToCounts(usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined): TokenCounts {
  const counts = createTokenCounts();
  if (!usage) return counts;
  counts.input = usage.input;
  counts.output = usage.output;
  counts.cacheRead = usage.cacheRead;
  counts.cacheWrite = usage.cacheWrite;
  counts.total = usage.totalTokens;
  return counts;
}

function addTokens(target: TokenCounts, source: TokenCounts): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

export default function (pi: ExtensionAPI) {
  let agentStartTime: number | null = null;
  let lastDurationMs: number | null = null;
  let lastRunTokens: TokenCounts = createTokenCounts();
  let compactionCount = 0;
  let requestCount = 0;

  // Tokens for the request currently being processed, and totals for the session.
  let runTokens: TokenCounts = createTokenCounts();
  let sessionTokens: TokenCounts = createTokenCounts();
  let sessionActiveMs = 0;
  let lastStatusUpdate = 0;

  // Reconstruct compaction count and token totals from session history on session start
  pi.on("session_start", async (_event, ctx) => {
    compactionCount = 0;
    requestCount = 0;
    agentStartTime = null;
    lastDurationMs = null;
    lastRunTokens = createTokenCounts();
    runTokens = createTokenCounts();
    sessionTokens = createTokenCounts();
    sessionActiveMs = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "compaction") {
        compactionCount++;
      } else if (entry.type === "message" && entry.message.role === "assistant") {
        addTokens(sessionTokens, usageToCounts(entry.message.usage));
      }
    }

    updateStatus(ctx);
  });

  // Track when the agent begins processing a request
  pi.on("agent_start", async (_event, ctx) => {
    agentStartTime = Date.now();
    requestCount++;
    runTokens = createTokenCounts();
    lastStatusUpdate = 0;
    updateStatus(ctx);
  });

  // Accumulate token usage as assistant messages complete
  pi.on("message_end", async (event, ctx) => {
    if (agentStartTime === null) return;

    if (event.message.role === "assistant") {
      const counts = usageToCounts(event.message.usage);
      addTokens(runTokens, counts);
      addTokens(sessionTokens, counts);
      updateStatus(ctx);
    }
  });

  // Refresh the throughput readout while a response is streaming (throttled)
  pi.on("message_update", async (_event, ctx) => {
    const now = Date.now();
    if (agentStartTime === null || now - lastStatusUpdate < 1000) return;
    lastStatusUpdate = now;
    updateStatus(ctx);
  });

  // Track when the agent has fully settled (includes retries, compactions, etc.)
  pi.on("agent_settled", async (_event, ctx) => {
    if (agentStartTime !== null) {
      lastDurationMs = Date.now() - agentStartTime;
      agentStartTime = null;
      sessionActiveMs += lastDurationMs;
      lastRunTokens = runTokens;
      runTokens = createTokenCounts();

      const durationStr = formatDuration(lastDurationMs);
      const outRate = formatRate(lastRunTokens.output, lastDurationMs);
      const totalRate = formatRate(lastRunTokens.total, lastDurationMs);
      const tokenStr =
        lastRunTokens.total > 0
          ? `, ${formatNumber(lastRunTokens.output)} output tokens @ ${outRate} tok/s, ${formatNumber(lastRunTokens.total)} total @ ${totalRate} tok/s`
          : "";

      ctx.ui.notify(
        `Request completed in ${durationStr} (${requestCount} request${requestCount !== 1 ? "s" : ""}, ${compactionCount} compaction${compactionCount !== 1 ? "s" : ""}${tokenStr})`,
        "info"
      );
    }

    updateStatus(ctx);
  });

  // Count compactions as they happen
  pi.on("session_before_compact", async (_event, ctx) => {
    compactionCount++;
    const durationStr = lastDurationMs !== null ? formatDuration(lastDurationMs) : "N/A";
    ctx.ui.setStatus(
      "pi-stat",
      ctx.ui.theme.fg("dim", ` 📦 compaction #${compactionCount}  ⏱ ${durationStr}`)
    );
  });

  // Register /stats command to show stats on demand
  pi.registerCommand("stats", {
    description: "Show session timing, token and compaction stats",
    handler: async (_args, ctx) => {
      const lines: string[] = [
        `Requests: ${requestCount}`,
        `Compactions: ${compactionCount}`,
      ];

      if (lastDurationMs !== null) {
        lines.push(
          `Last request: ${formatDuration(lastDurationMs)}, ${formatNumber(lastRunTokens.output)} output tokens @ ${formatRate(lastRunTokens.output, lastDurationMs)} tok/s, ${formatNumber(lastRunTokens.total)} total tokens @ ${formatRate(lastRunTokens.total, lastDurationMs)} tok/s`
        );
      }

      if (agentStartTime !== null) {
        const elapsed = Date.now() - agentStartTime;
        lines.push(
          `Current request: ${formatDuration(elapsed)} (running...) @ ${formatRate(runTokens.output, elapsed)} tok/s, ${formatNumber(runTokens.total)} total tokens so far`
        );
      }

      lines.push(`Session active time: ${formatDuration(sessionActiveMs)}`);
      lines.push(
        `Session throughput: ${formatNumber(sessionTokens.output)} output tokens @ ${formatRate(sessionTokens.output, sessionActiveMs)} tok/s`
      );
      lines.push(
        `Session tokens: ${formatNumber(sessionTokens.total)} total (${formatNumber(sessionTokens.input)} in / ${formatNumber(sessionTokens.output)} out, cache ${formatNumber(sessionTokens.cacheRead)} read / ${formatNumber(sessionTokens.cacheWrite)} write)`
      );

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  function updateStatus(ctx: ExtensionContext) {
    const compactionStr = compactionCount === 0 ? "" : `  📦 ${compactionCount}`;

    if (agentStartTime !== null) {
      // Mid-request: show elapsed time and throughput so far.
      const elapsed = Date.now() - agentStartTime;
      const rate = formatRate(runTokens.output, elapsed);
      const statusText = ` ⏱ ${formatDuration(elapsed)}  ⚡ ${rate} tok/s${runTokens.total > 0 ? ` (${formatNumber(runTokens.total)} tk)` : ""}${compactionStr}`;
      ctx.ui.setStatus("pi-stat", ctx.ui.theme.fg("dim", statusText));
      return;
    }

    const durationStr = lastDurationMs !== null ? formatDuration(lastDurationMs) : "—";
    const rateStr =
      lastDurationMs !== null && lastRunTokens.output > 0
        ? `  ⚡ ${formatRate(lastRunTokens.output, lastDurationMs)} tok/s`
        : "  ⚡ —";
    const statusText = ` ⏱ ${durationStr} ${rateStr}${compactionStr}`;

    ctx.ui.setStatus("pi-stat", ctx.ui.theme.fg("dim", statusText));
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = (seconds % 60).toFixed(1);
  return `${minutes}m ${remainingSeconds}s`;
}

function formatRate(tokens: number, ms: number): string {
  if (ms <= 0 || tokens <= 0) return "0";
  const rate = tokens / (ms / 1000);
  return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
