#!/usr/bin/env node
'use strict';
const fs = require('fs');

function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) { console.error('usage: script <in.json> <out.json>'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const fileNodes = data.fileNodes || [];
  const importEdges = data.importEdges || [];
  const allEdges = data.allEdges || [];

  const byId = new Map(fileNodes.map(n => [n.id, n]));

  // ---- Common prefix of code-ish file paths ----
  const paths = fileNodes.map(n => n.filePath).filter(Boolean);
  function commonPrefix(strs) {
    if (!strs.length) return '';
    const segLists = strs.map(s => s.split('/'));
    let prefix = [];
    const minLen = Math.min(...segLists.map(s => s.length));
    for (let i = 0; i < minLen - 1; i++) { // never consume the filename
      const seg = segLists[0][i];
      if (segLists.every(s => s[i] === seg)) prefix.push(seg); else break;
    }
    return prefix.length ? prefix.join('/') + '/' : '';
  }
  const prefix = commonPrefix(paths);

  // ---- A. Directory grouping ----
  function groupOf(fp) {
    if (!fp) return 'root';
    let rest = fp;
    if (prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length);
    const segs = rest.split('/');
    if (segs.length === 1) return 'root';
    return segs[0];
  }
  const directoryGroups = {};
  for (const n of fileNodes) {
    const g = groupOf(n.filePath);
    (directoryGroups[g] = directoryGroups[g] || []).push(n.id);
  }

  // ---- B. Node type grouping ----
  const nodeTypeGroups = {};
  for (const n of fileNodes) (nodeTypeGroups[n.type] = nodeTypeGroups[n.type] || []).push(n.id);

  // ---- C. Adjacency, fan-in/out ----
  const fanOut = {}, fanIn = {};
  for (const n of fileNodes) { fanOut[n.id] = 0; fanIn[n.id] = 0; }
  for (const e of importEdges) {
    if (fanOut[e.source] !== undefined) fanOut[e.source]++;
    if (fanIn[e.target] !== undefined) fanIn[e.target]++;
  }

  // ---- D. Cross-category edges ----
  const ccMap = {};
  for (const e of allEdges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    if (s.type === t.type) continue; // cross-category only
    const key = s.type + '->' + t.type + '|' + e.type;
    ccMap[key] = (ccMap[key] || 0) + 1;
  }
  const crossCategoryEdges = Object.entries(ccMap).map(([k, count]) => {
    const [pair, edgeType] = k.split('|');
    const [fromType, toType] = pair.split('->');
    return { fromType, toType, edgeType, count };
  }).sort((a, b) => b.count - a.count);

  // ---- E. Inter-group import frequency ----
  const interMap = {};
  for (const e of importEdges) {
    const s = byId.get(e.source), t = byId.get(e.target);
    if (!s || !t) continue;
    const gs = groupOf(s.filePath), gt = groupOf(t.filePath);
    if (gs === gt) continue;
    const key = gs + '->' + gt;
    interMap[key] = (interMap[key] || 0) + 1;
  }
  const interGroupImports = Object.entries(interMap).map(([k, count]) => {
    const [from, to] = k.split('->');
    return { from, to, count };
  }).sort((a, b) => b.count - a.count);

  // ---- F. Intra-group density ----
  const intraGroupDensity = {};
  for (const g of Object.keys(directoryGroups)) {
    let internal = 0, total = 0;
    for (const e of importEdges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      const gs = groupOf(s.filePath), gt = groupOf(t.filePath);
      if (gs === g || gt === g) total++;
      if (gs === g && gt === g) internal++;
    }
    intraGroupDensity[g] = { internalEdges: internal, totalEdges: total, density: total ? +(internal / total).toFixed(3) : 0 };
  }

  // ---- G. Pattern matching ----
  const dirPatterns = [
    [['routes','api','controllers','endpoints','handlers'],'api'],
    [['services','core','lib','domain','logic'],'service'],
    [['models','db','data','persistence','repository','entities'],'data'],
    [['components','views','pages','ui','layouts','screens'],'ui'],
    [['middleware','plugins','interceptors','guards'],'middleware'],
    [['utils','helpers','common','shared','tools'],'utility'],
    [['config','constants','env','settings'],'config'],
    [['__tests__','test','tests','spec','specs'],'test'],
    [['types','interfaces','schemas','contracts','dtos'],'types'],
    [['hooks'],'hooks'],
    [['store','state','reducers','actions','slices'],'state'],
    [['assets','static','public'],'assets'],
    [['migrations'],'data'],
    [['management','commands'],'config'],
    [['signals'],'service'],
    [['cmd','bin'],'entry'],
    [['internal'],'service'],
    [['pkg'],'utility'],
    [['docs','documentation','wiki'],'documentation'],
    [['deploy','deployment','infra','infrastructure','docker'],'infrastructure'],
    [['k8s','kubernetes','helm','charts','terraform','tf'],'infrastructure'],
    [['sql','database'],'data'],
    [['experiments'],'experiment'],
    [['llm'],'service'],
    [['match'],'service'],
    [['maintain'],'service'],
    [['write'],'service'],
    [['read'],'service'],
    [['iii'],'service'],
    [['mcp'],'api'],
  ];
  function patternFor(dir) {
    const d = dir.toLowerCase();
    for (const [names, label] of dirPatterns) if (names.includes(d)) return label;
    return null;
  }
  const patternMatches = {};
  for (const g of Object.keys(directoryGroups)) {
    const p = patternFor(g);
    if (p) patternMatches[g] = p;
  }

  // ---- H. Deployment topology ----
  const lcPaths = paths.map(p => p.toLowerCase());
  const has = (re) => lcPaths.some(p => re.test(p));
  const infraFiles = fileNodes.filter(n => {
    const p = (n.filePath || '').toLowerCase();
    return /dockerfile/.test(p) || /docker-compose/.test(p) || /\.dockerignore/.test(p) ||
      /\.tf$/.test(p) || /k8s|kubernetes|helm/.test(p) || /worker-entrypoint/.test(p) ||
      n.type === 'service';
  }).map(n => n.filePath || n.id);
  const deploymentTopology = {
    hasDockerfile: has(/dockerfile/),
    hasCompose: has(/docker-compose/),
    hasK8s: has(/k8s|kubernetes|helm/),
    hasTerraform: has(/\.tf$/),
    hasCI: has(/\.github\/workflows|\.gitlab-ci|jenkinsfile/),
    infraFiles: [...new Set(infraFiles)],
  };

  // ---- I. Data pipeline ----
  const dataPipeline = {
    schemaFiles: fileNodes.filter(n => /schema/i.test(n.filePath || '') || (n.tags||[]).includes('schema-definition')).map(n => n.filePath),
    migrationFiles: fileNodes.filter(n => /migration|bootstrap/i.test(n.filePath || '') || (n.tags||[]).includes('migration')).map(n => n.filePath),
    dataModelFiles: fileNodes.filter(n => (n.tags||[]).includes('data-model')).map(n => n.filePath),
    apiHandlerFiles: fileNodes.filter(n => (n.tags||[]).includes('api-handler')).map(n => n.filePath),
  };

  // ---- J. Documentation coverage ----
  const docNodes = fileNodes.filter(n => n.type === 'document');
  const groupsWithDocs = new Set();
  for (const d of docNodes) groupsWithDocs.add(groupOf(d.filePath));
  const totalGroups = Object.keys(directoryGroups).length;
  const undocumentedGroups = Object.keys(directoryGroups).filter(g => !groupsWithDocs.has(g));
  const docCoverage = {
    groupsWithDocs: groupsWithDocs.size,
    totalGroups,
    coverageRatio: totalGroups ? +(groupsWithDocs.size / totalGroups).toFixed(2) : 0,
    undocumentedGroups,
  };

  // ---- K. Dependency direction ----
  const pairSeen = new Set();
  const dependencyDirection = [];
  for (const { from, to, count } of interGroupImports) {
    const key = [from, to].sort().join('::');
    if (pairSeen.has(key)) continue;
    pairSeen.add(key);
    const reverse = interMap[to + '->' + from] || 0;
    if (count >= reverse) dependencyDirection.push({ dependent: from, dependsOn: to });
    else dependencyDirection.push({ dependent: to, dependsOn: from });
  }

  // ---- Stats ----
  const filesPerGroup = {};
  for (const g of Object.keys(directoryGroups)) filesPerGroup[g] = directoryGroups[g].length;
  const nodeTypeCounts = {};
  for (const t of Object.keys(nodeTypeGroups)) nodeTypeCounts[t] = nodeTypeGroups[t].length;

  const result = {
    scriptCompleted: true,
    commonPrefix: prefix,
    directoryGroups,
    nodeTypeGroups,
    crossCategoryEdges,
    interGroupImports,
    intraGroupDensity,
    patternMatches,
    deploymentTopology,
    dataPipeline,
    docCoverage,
    dependencyDirection,
    fileStats: { totalFileNodes: fileNodes.length, filesPerGroup, nodeTypeCounts },
    fileFanIn: fanIn,
    fileFanOut: fanOut,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('OK: groups=' + Object.keys(directoryGroups).length + ' files=' + fileNodes.length);
}

try { main(); } catch (e) { console.error(e && e.stack || e); process.exit(1); }
