// AI summarization for reconciliation (Phase 4). Output is a suggestion: every claim must cite input record ids,
// is validated before display, and nothing here writes to a chart.
export * from "@/ai/input";
export * from "@/ai/prompt";
export * from "@/ai/responders";
export * from "@/ai/validate";
export { conditionMentions } from "@/ai/conditions";
