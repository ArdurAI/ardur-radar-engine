/**
 * Signal Map — ports `oss-signal-map.mjs` + `build-oss-signal-map-export.mjs`.
 *
 * Builds a node/edge knowledge graph over the Top-10: projects linked to their
 * category, owner, language, topics, and platform-source chatter, plus
 * project↔project cluster edges within a shared category. The export shape is
 * what /radar's Signal Map visualization consumes.
 */

import type {
  RankedSignal,
  MomentumSnapshot,
  SignalNode,
  SignalEdge,
  SignalNodeType,
  SignalRelation,
  SignalMapExport,
} from './types.ts';
import { stableId } from './util.ts';
import { lookupMomentum } from './momentum.ts';

const TOPICS_PER_PROJECT = 4;

interface Builder {
  nodes: Map<string, SignalNode>;
  edges: SignalEdge[];
}

function ensureNode(b: Builder, type: SignalNodeType, value: string, label: string): string {
  const id = stableId(type, value);
  if (!b.nodes.has(id)) b.nodes.set(id, { id, type, label });
  return id;
}

function addEdge(
  b: Builder,
  from: string,
  to: string,
  relation: SignalRelation,
  weight: number,
  confidence: SignalEdge['confidence'],
): void {
  b.edges.push({ from, to, relation, weight, confidence });
}

/** Build the signal-map export from the ranked Top-10 (+ optional momentum). */
export function buildSignalMap(
  topTen: RankedSignal[],
  momentum: MomentumSnapshot | null,
  now: Date,
): SignalMapExport {
  const b: Builder = { nodes: new Map(), edges: [] };
  const projectNodeByCategory = new Map<string, string[]>();
  const rankedList: SignalMapExport['rankedList'] = [];

  for (const signal of topTen) {
    const projectNodeId = stableId('project', signal.id);
    b.nodes.set(projectNodeId, {
      id: projectNodeId,
      type: 'project',
      label: signal.name,
      rank: signal.rank,
      score: signal.score,
    });
    rankedList.push({
      id: signal.id,
      nodeId: projectNodeId,
      rank: signal.rank,
      score: signal.score,
    });

    const categoryId = ensureNode(b, 'category', signal.category, signal.categoryLabel);
    addEdge(b, projectNodeId, categoryId, 'same-category', 0.9, 'high');
    const peers = projectNodeByCategory.get(categoryId) ?? [];
    for (const peer of peers) addEdge(b, projectNodeId, peer, 'cluster', 0.55, 'medium');
    peers.push(projectNodeId);
    projectNodeByCategory.set(categoryId, peers);

    const ownerId = ensureNode(b, 'owner', signal.owner, signal.owner);
    addEdge(b, projectNodeId, ownerId, 'same-org', 0.75, 'high');

    if (signal.language) {
      const langId = ensureNode(b, 'language', signal.language, signal.language);
      addEdge(b, projectNodeId, langId, 'shared-language', 0.6, 'medium');
    }

    for (const topic of signal.topics.slice(0, TOPICS_PER_PROJECT)) {
      const topicId = ensureNode(b, 'topic', topic, topic);
      addEdge(b, projectNodeId, topicId, 'shared-topic', 0.7, 'medium');
    }

    const m = momentum ? lookupMomentum(signal.id, momentum) : null;
    if (m) {
      for (const platform of new Set(
        m.realMetrics.map((metric) => String(metric['type'] ?? '')).filter((t) => t.length > 0),
      )) {
        const platformId = ensureNode(b, 'platform-source', platform, platform);
        addEdge(b, projectNodeId, platformId, 'co-mention', 0.4, 'medium');
      }
    }
  }

  const nodes = [...b.nodes.values()];
  return {
    schemaVersion: 'oss-signal-map-export/v1',
    generatedAt: now.toISOString(),
    generatedBy: 'deterministic-oss-signal-map-export-v1',
    stats: { nodeCount: nodes.length, edgeCount: b.edges.length, projectCount: topTen.length },
    legend: {
      nodeTypes: ['project', 'category', 'language', 'owner', 'topic', 'platform-source'],
      relationTypes: ['same-category', 'shared-topic', 'shared-language', 'same-org', 'co-mention'],
    },
    nodes,
    edges: b.edges,
    layout: {
      rings: [
        { id: 'core', label: 'Top 10 projects', nodeTypes: ['project'] },
        {
          id: 'taxonomy',
          label: 'Category, language, owner',
          nodeTypes: ['category', 'language', 'owner', 'topic'],
        },
        { id: 'chatter', label: 'Platform chatter', nodeTypes: ['platform-source'] },
      ],
    },
    rankedList,
  };
}
