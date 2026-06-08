import type { ISalesforceObject, IOccurrence, IGraphNode, IExecutionGraph } from './types';

// ── Tree walker ───────────────────────────────────────────────────────────────

function walk(
  objects: ISalesforceObject[],
  ancestorChain: ISalesforceObject[],
  graph: IExecutionGraph
): void {
  for (const obj of objects) {
    const parentObjectName = ancestorChain.length
      ? ancestorChain[ancestorChain.length - 1].name
      : null;

    const occurrence: IOccurrence = {
      ...obj,
      parentObjectName,
      depth: ancestorChain.length,
      ancestorChain: [...ancestorChain],
    };

    if (!graph.has(obj.name)) {
      graph.set(obj.name, { occurrences: [], dependsOn: new Set() });
    }

    const node = graph.get(obj.name)!;
    node.occurrences.push(occurrence);

    for (const anc of ancestorChain) {
      node.dependsOn.add(anc.name);
    }

    if (obj.children?.length) {
      walk(obj.children, [...ancestorChain, obj], graph);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Converts the hierarchical payload tree into a DAG where each unique object
 * name is one node. Multiple occurrences of the same object across different
 * tree branches are collected under a single node so their ID results can be
 * merged before any child runs.
 */
export function buildExecutionGraph(payload: { objects: ISalesforceObject[] }): IExecutionGraph {
  const graph: IExecutionGraph = new Map();
  walk(payload.objects, [], graph);
  return graph;
}

/**
 * Topological sort via Kahn's algorithm.
 * Returns object names in execution order — all dependencies before dependents.
 * Throws if the graph contains a cycle.
 */
export function topologicalSort(graph: IExecutionGraph): string[] {
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>(); // dep → list of objects that depend on dep

  for (const [name] of graph) {
    if (!inDegree.has(name)) inDegree.set(name, 0);
    if (!children.has(name)) children.set(name, []);
  }

  for (const [name, node] of graph) {
    for (const dep of node.dependsOn) {
      if (!children.has(dep)) children.set(dep, []);
      children.get(dep)!.push(name);
      inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  const result: string[] = [];

  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  while (queue.length) {
    const name = queue.shift()!;
    result.push(name);

    for (const dependent of (children.get(name) ?? [])) {
      const newDeg = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (result.length !== graph.size) {
    throw new Error('Cycle detected in execution graph');
  }

  return result;
}
