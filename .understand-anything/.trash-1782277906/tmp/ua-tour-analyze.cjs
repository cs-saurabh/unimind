#!/usr/bin/env node
'use strict';

const fs = require('fs');

function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error('Usage: node ua-tour-analyze.js <input.json> <output.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  const layers = data.layers || [];

  const byId = new Map();
  for (const n of nodes) byId.set(n.id, n);

  // Fan-in / fan-out
  const fanIn = new Map();
  const fanOut = new Map();
  for (const n of nodes) { fanIn.set(n.id, 0); fanOut.set(n.id, 0); }
  // adjacency for imports/calls forward traversal
  const fwd = new Map(); // imports + calls
  for (const n of nodes) fwd.set(n.id, []);
  for (const e of edges) {
    if (fanOut.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
    if (fanIn.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
    if ((e.type === 'imports' || e.type === 'calls') && fwd.has(e.source)) {
      fwd.get(e.source).push(e.target);
    }
  }

  const nm = (id) => (byId.get(id) ? byId.get(id).name : id);

  const fanInRanking = nodes
    .map((n) => ({ id: n.id, fanIn: fanIn.get(n.id), name: n.name }))
    .sort((a, b) => b.fanIn - a.fanIn)
    .slice(0, 20);

  const fanOutRanking = nodes
    .map((n) => ({ id: n.id, fanOut: fanOut.get(n.id), name: n.name }))
    .sort((a, b) => b.fanOut - a.fanOut)
    .slice(0, 20);

  // Entry point candidates
  const codeEntryNames = new Set([
    'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js',
    'server.ts', 'server.js', 'mod.rs', 'main.go', 'main.py', 'main.rs',
    'manage.py', 'app.py', 'wsgi.py', 'asgi.py', 'run.py', '__main__.py',
    'Application.java', 'Main.java', 'Program.cs', 'config.ru', 'index.php',
    'App.swift', 'Application.kt', 'main.cpp', 'main.c'
  ]);

  // thresholds
  const foVals = nodes.map((n) => fanOut.get(n.id)).sort((a, b) => b - a);
  const top10pctIdx = Math.max(0, Math.floor(foVals.length * 0.1) - 1);
  const top10pctThreshold = foVals.length ? foVals[top10pctIdx] : 0;
  const fiVals = nodes.map((n) => fanIn.get(n.id)).sort((a, b) => a - b);
  const bottom25Idx = Math.max(0, Math.floor(fiVals.length * 0.25) - 1);
  const bottom25Threshold = fiVals.length ? fiVals[bottom25Idx] : 0;

  function depth(fp) {
    if (!fp) return 99;
    return fp.split('/').length - 1;
  }

  const epScores = [];
  for (const n of nodes) {
    let score = 0;
    const fp = n.filePath || '';
    if (n.type === 'document') {
      const base = (n.name || '').toLowerCase();
      const isRoot = depth(fp) === 0;
      if (base === 'readme.md' && isRoot) score += 5;
      else if (base.endsWith('.md') && isRoot) score += 2;
      else if (base.endsWith('.mdx') && isRoot) score += 2;
    } else if (n.type === 'file') {
      if (codeEntryNames.has(n.name)) score += 3;
      if (depth(fp) <= 1) score += 1;
      if (fanOut.get(n.id) >= top10pctThreshold && fanOut.get(n.id) > 0) score += 1;
      if (fanIn.get(n.id) <= bottom25Threshold) score += 1;
    }
    if (score > 0) epScores.push({ id: n.id, score, name: n.name, summary: n.summary || '' });
  }
  epScores.sort((a, b) => b.score - a.score);
  const entryPointCandidates = epScores.slice(0, 5);

  // BFS from top code entry point
  const codeCandidates = epScores.filter((c) => byId.get(c.id) && byId.get(c.id).type === 'file');
  let startNode = codeCandidates.length ? codeCandidates[0].id : (nodes.find((n) => n.type === 'file') || {}).id;

  const order = [];
  const depthMap = {};
  if (startNode) {
    const q = [startNode];
    depthMap[startNode] = 0;
    while (q.length) {
      const cur = q.shift();
      order.push(cur);
      for (const nb of (fwd.get(cur) || [])) {
        if (!(nb in depthMap)) {
          depthMap[nb] = depthMap[cur] + 1;
          q.push(nb);
        }
      }
    }
  }
  const byDepth = {};
  for (const [id, d] of Object.entries(depthMap)) {
    (byDepth[d] = byDepth[d] || []).push(id);
  }

  // Non-code inventory
  const nonCodeFiles = { documentation: [], infrastructure: [], data: [], config: [] };
  for (const n of nodes) {
    const item = { id: n.id, name: n.name, type: n.type, summary: n.summary || '' };
    if (n.type === 'document') nonCodeFiles.documentation.push(item);
    else if (['service', 'pipeline', 'resource'].includes(n.type)) nonCodeFiles.infrastructure.push(item);
    else if (['table', 'schema', 'endpoint'].includes(n.type)) nonCodeFiles.data.push(item);
    else if (n.type === 'config') nonCodeFiles.config.push(item);
  }

  // Clusters: bidirectional imports/calls pairs, then expand
  const fwdSet = new Map();
  for (const [s, arr] of fwd.entries()) fwdSet.set(s, new Set(arr));
  const pairs = [];
  const seen = new Set();
  for (const [s, arr] of fwdSet.entries()) {
    for (const t of arr) {
      if (fwdSet.has(t) && fwdSet.get(t).has(s)) {
        const key = [s, t].sort().join('||');
        if (!seen.has(key)) { seen.add(key); pairs.push([s, t]); }
      }
    }
  }
  // edge count between a set of nodes (any direction, any type)
  function edgeCount(set) {
    let c = 0;
    for (const e of edges) {
      if (set.has(e.source) && set.has(e.target)) c++;
    }
    return c;
  }
  // neighbors (any direction)
  const undir = new Map();
  for (const n of nodes) undir.set(n.id, new Set());
  for (const e of edges) {
    if (undir.has(e.source)) undir.get(e.source).add(e.target);
    if (undir.has(e.target)) undir.get(e.target).add(e.source);
  }
  const clusters = [];
  const clusterKeys = new Set();
  for (const [a, b] of pairs) {
    const set = new Set([a, b]);
    // expand: add nodes connected to 2+ members
    let changed = true;
    while (changed && set.size < 5) {
      changed = false;
      const counts = new Map();
      for (const m of set) {
        for (const nb of undir.get(m)) {
          if (!set.has(nb)) counts.set(nb, (counts.get(nb) || 0) + 1);
        }
      }
      let best = null, bestC = 0;
      for (const [nb, c] of counts) {
        if (c >= 2 && c > bestC) { best = nb; bestC = c; }
      }
      if (best) { set.add(best); changed = true; }
    }
    const key = [...set].sort().join('||');
    if (!clusterKeys.has(key)) {
      clusterKeys.add(key);
      clusters.push({ nodes: [...set], edgeCount: edgeCount(set) });
    }
  }
  clusters.sort((a, b) => b.edgeCount - a.edgeCount);
  const topClusters = clusters.slice(0, 10);

  // Layers
  const layerOut = {
    count: layers.length,
    list: layers.map((l) => ({ id: l.id, name: l.name, description: l.description }))
  };

  // Node summary index
  const nodeSummaryIndex = {};
  for (const n of nodes) {
    nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary || '' };
  }

  const out = {
    scriptCompleted: true,
    entryPointCandidates,
    fanInRanking,
    fanOutRanking,
    bfsTraversal: { startNode, order, depthMap, byDepth },
    nonCodeFiles,
    clusters: topClusters,
    layers: layerOut,
    nodeSummaryIndex,
    totalNodes: nodes.length,
    totalEdges: edges.length
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  process.exit(0);
}

try { main(); } catch (e) { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); }
