import chalk from "chalk";
import type { Stage } from "../domain/types.js";

export function colorStage(stage: Stage, doNotContact: boolean): string {
  if (doNotContact) return chalk.red(stage);
  if (stage === "won") return chalk.green(stage);
  if (stage === "dormant") return chalk.yellow(stage);
  if (stage === "canceled") return chalk.yellow(stage);
  if (stage === "lost") return chalk.gray(stage);
  return chalk.cyan(stage);
}

export function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return chalk.dim("never");
  return new Date(iso).toLocaleString();
}
