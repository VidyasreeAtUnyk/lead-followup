import chalk from "chalk";
import type { RunProgress } from "../agent/loop.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;

/**
 * Live terminal progress for `cli process`: a spinner line ("thinking...",
 * elapsed time, tokens so far) that gets replaced by a permanent line each
 * time a tool call resolves -- similar in spirit to how Claude Code's own
 * CLI shows elapsed time/tokens while working and a persistent line per
 * tool use. Purely a rendering concern -- carries no state the agent
 * depends on.
 */
export class RunProgressRenderer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIdx = 0;
  private startedAt = 0;
  private tokensSoFar = 0;
  private label = "";

  startLead(label: string): void {
    this.label = label;
    this.startedAt = Date.now();
    this.tokensSoFar = 0;
    this.frameIdx = 0;
    this.render();
    this.timer = setInterval(() => this.render(), TICK_MS);
  }

  onProgress(progress: RunProgress): void {
    this.tokensSoFar = progress.tokensSoFar;
    if (progress.phase === "tool_call" && progress.toolName) {
      this.printPermanentLine(`  ${chalk.green("✓")} ${progress.toolName}`);
    }
  }

  /** Stops the spinner and prints a final permanent summary line for this lead. */
  finishLead(finalLine: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write(`\r\x1b[K${finalLine}\n`);
  }

  private render(): void {
    this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
    const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const line = `${chalk.cyan(FRAMES[this.frameIdx])} ${this.label} ${chalk.dim(
      `thinking... (${secs}s · ~${this.tokensSoFar} tokens)`
    )}`;
    process.stdout.write(`\r\x1b[K${line}`);
  }

  private printPermanentLine(text: string): void {
    process.stdout.write(`\r\x1b[K${text}\n`);
  }
}
