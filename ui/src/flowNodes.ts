import type { Node } from "@xyflow/react";

/** Keep renderer measurements when domain data refreshes fixed-layout nodes. */
export function reconcileFlowNodes<T extends Node>(current: T[], incoming: T[]): T[] {
  const previous = new Map(current.map((node) => [node.id, node]));
  return incoming.map((node) => {
    const prior = previous.get(node.id);
    if (prior?.type !== node.type || !prior?.measured || node.measured) return node;
    return { ...node, measured: prior.measured };
  });
}
