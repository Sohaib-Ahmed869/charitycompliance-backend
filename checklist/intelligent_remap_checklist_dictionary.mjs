#!/usr/bin/env node
/**
 * Intelligent checklist remapper
 *
 * Purpose:
 * - Use the original checklist dictionary as source pool.
 * - Use sidebar-sorted dictionary as taxonomy skeleton (module/submodule targets).
 * - Classify each item into the most suitable sidebar node.
 * - Prefer OpenAI classification (when OPENAI_API_KEY is available), with heuristic fallback.
 *
 * Usage:
 *   node checklist/intelligent_remap_checklist_dictionary.mjs
 *   node checklist/intelligent_remap_checklist_dictionary.mjs --dry-run
 *   node checklist/intelligent_remap_checklist_dictionary.mjs --limit=500 --batch=25 --model=gpt-4o-mini
 *
 * Env:
 *   OPENAI_API_KEY=...
 */

import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_PATH = path.resolve(__dirname, 'checklist_module_dictionary.json');
const TARGET_PATH = path.resolve(__dirname, 'checklist_module_dictionary_sidebar_sorted.json');
const GUIDE_PATH = path.resolve(__dirname, 'checklist_module_mapping_guide.md');
const DEFAULT_MODEL = process.env.CHECKLIST_CLASSIFIER_MODEL || 'gpt-4o-mini';

const PATH_RULES = {
  'GOVERNANCE > Charity Administration > Yearly Statements': {
    include: /(annual|yearly|annual information statement|ais|financial statement|annual report|acnc)/,
    exclude: /(volunteer|social media|campaign|donor|fundraising campaign|training|induction)/,
  },
  'GOVERNANCE > Policies & Procedures': {
    include: /(policy|procedure|code of conduct|version|review|acknowledg)/,
    exclude: /(donor register|project monitoring|bank account transfer|registration number)/,
  },
  'FUNDING > Grants & Donors > Donor Register': {
    include: /(donor|donation|pledge|receipt|fundraising|gift)/,
    exclude: /(board member|director|trustee|wwcc|working with children|policy review)/,
  },
  'REPORTING > Weekly Reports': {
    include: /(weekly|week|status update|reporting cadence|kpi|metric)/,
    exclude: /(board member declaration|wwcc|police check|constitution)/,
  },
  'OPERATIONS > People & HR > Trainings': {
    include: /(training|induction|workshop|course|learning|competency)/,
    exclude: /(registration|license|licence|permit|acnc registration)/,
  },
  'OPERATIONS > Volunteers': {
    include: /(volunteer|volunteering|volunteer coordinator|volunteer handbook|volunteer application)/,
    exclude: /(board member|director|trustee|annual information statement)/,
  },
  'GOVERNANCE > Charity Administration > Responsible People': {
    include: /(responsible person|board member|director|trustee|wwcc|working with children|police check|fit and proper|consent)/,
    exclude: /(social media|campaign|donor|project monitoring|policy documentation|fundraising campaign)/,
  }
};

function parseArgs(argv = []) {
  const out = {
    dryRun: false,
    limit: null,
    batch: 20,
    model: DEFAULT_MODEL
  };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.split('=')[1]) || null;
    else if (arg.startsWith('--batch=')) out.batch = Math.max(1, Number(arg.split('=')[1]) || 20);
    else if (arg.startsWith('--model=')) out.model = arg.split('=')[1] || DEFAULT_MODEL;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node checklist/intelligent_remap_checklist_dictionary.mjs [--dry-run] [--limit=500] [--batch=25] [--model=gpt-4o-mini]');
      process.exit(0);
    }
  }
  return out;
}

function cleanText(v) {
  return String(v || '')
    .replace(/^[\u2610\u2611\u2713]\s*/, '')
    .replace(/^\d+(\.\d+)*\s*[\).:\-]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(v) {
  return cleanText(v)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function flattenSourceDictionary(source) {
  const rows = [];
  const seen = new Set();
  for (const [moduleKey, moduleNode] of Object.entries(source || {})) {
    for (const checklist of moduleNode?.checklists || []) {
      const checklistTitle = cleanText(checklist?.title);
      for (const [sectionName, sectionItems] of Object.entries(checklist?.sections || {})) {
        for (const raw of sectionItems || []) {
          const text = cleanText(raw);
          if (!text) continue;
          const low = text.toLowerCase();
          if (seen.has(low)) continue;
          seen.add(low);
          rows.push({
            text,
            sourceModuleKey: moduleKey,
            sourceChecklistTitle: checklistTitle,
            sourceSection: cleanText(sectionName)
          });
        }
      }
    }
  }
  return rows;
}

function extractTargetNodes(sidebarDict) {
  const nodes = [];
  for (const [sectionName, sectionNode] of Object.entries(sidebarDict || {})) {
    if (sectionName === '_meta' || !sectionNode || typeof sectionNode !== 'object') continue;
    for (const [moduleName, moduleNode] of Object.entries(sectionNode || {})) {
      // leaf module
      if (Array.isArray(moduleNode?.items)) {
        nodes.push({
          id: `${sectionName}::${moduleName}`,
          sectionName,
          moduleName,
          submoduleName: null,
          pathLabel: `${sectionName} > ${moduleName}`,
          sourceKeys: moduleNode?.source_dictionary_keys || [],
          filterKeywords: moduleNode?.filter_keywords || [],
          pointer: { sectionName, moduleName, submoduleName: null }
        });
        continue;
      }
      // module with submodules
      for (const [submoduleName, subNode] of Object.entries(moduleNode || {})) {
        if (!subNode || typeof subNode !== 'object' || !Array.isArray(subNode.items)) continue;
        nodes.push({
          id: `${sectionName}::${moduleName}::${submoduleName}`,
          sectionName,
          moduleName,
          submoduleName,
          pathLabel: `${sectionName} > ${moduleName} > ${submoduleName}`,
          sourceKeys: subNode?.source_dictionary_keys || [],
          filterKeywords: subNode?.filter_keywords || [],
          pointer: { sectionName, moduleName, submoduleName }
        });
      }
    }
  }
  return nodes;
}

function parseGuideKeywordsMap(markdownText) {
  const map = new Map();
  const lines = String(markdownText || '').split(/\r?\n/);
  let activePath = null;
  for (const line of lines) {
    const pathMatch = line.match(/^- Path:\s*`(.+?)`\s*$/);
    if (pathMatch) {
      activePath = pathMatch[1].trim();
      if (!map.has(activePath)) map.set(activePath, []);
      continue;
    }
    const kwMatch = line.match(/^- Keywords:\s*(.+)\s*$/);
    if (kwMatch && activePath) {
      const kws = kwMatch[1].split(',').map((k) => k.trim()).filter(Boolean);
      map.set(activePath, kws);
      continue;
    }
  }
  return map;
}

function nodeKeywords(node, guideKeywordMap = new Map()) {
  const labelTokens = tokenize(`${node.sectionName} ${node.moduleName} ${node.submoduleName || ''}`);
  const filterTokens = (node.filterKeywords || []).flatMap((k) => tokenize(k));
  const guideTokens = (guideKeywordMap.get(node.pathLabel) || []).flatMap((k) => tokenize(k));
  return Array.from(new Set([...labelTokens, ...filterTokens, ...guideTokens]));
}

function roleScoreAdjust(itemTextLower, node) {
  const isVolunteerItem = /volunteer|volunteering|volunteer coordinator|volunteer handbook|volunteer application/.test(itemTextLower);
  const isResponsibleItem = /responsible person|board member|director|trustee|wwcc|working with children|police check/.test(itemTextLower);
  const isTrainingItem = /training|induction|workshop|course|competency|learning/.test(itemTextLower);
  const isEmployeeItem = /employee|staff|employment|offboarding|hr/.test(itemTextLower);

  const nodePath = node.pathLabel.toLowerCase();
  let delta = 0;
  if (isVolunteerItem) {
    if (nodePath.includes('> volunteers')) delta += 4;
    if (nodePath.includes('responsible people') || nodePath.includes('employees')) delta -= 2;
  }
  if (isResponsibleItem) {
    if (nodePath.includes('responsible people')) delta += 4;
    if (nodePath.includes('volunteers')) delta -= 2;
  }
  if (isTrainingItem) {
    if (nodePath.includes('> trainings') || nodePath.includes('training register')) delta += 3;
    if (nodePath.includes('responsible people')) delta -= 1;
  }
  if (isEmployeeItem) {
    if (nodePath.includes('> employees')) delta += 3;
    if (nodePath.includes('volunteers')) delta -= 1;
  }
  if (nodePath.includes('responsible people')) {
    if (/social media|marketing|campaign|donor|project|partner|funding agreement|policy documentation|safeguarding policy/.test(itemTextLower)) delta -= 6;
  }
  if (nodePath.includes('> volunteers')) {
    if (/board member|director|trustee|responsible person/.test(itemTextLower)) delta -= 4;
  }
  if (nodePath.includes('> employees')) {
    if (/board member|trustee|director|coi/.test(itemTextLower)) delta -= 4;
  }
  if (nodePath.includes('trainings')) {
    if (/permit|license|licence|registration/.test(itemTextLower)) delta -= 3;
  }
  return delta;
}

function heuristicScore(item, node, nodeTokenMap) {
  const text = `${item.text} ${item.sourceChecklistTitle} ${item.sourceSection}`.toLowerCase();
  const itemTokens = new Set(tokenize(text));
  const nTokens = nodeTokenMap.get(node.id) || [];
  let overlap = 0;
  for (const tok of nTokens) {
    if (itemTokens.has(tok) || text.includes(tok)) overlap += 1;
  }
  let weighted = overlap + (node.submoduleName ? 0.6 : 0.2) + roleScoreAdjust(text, node);
  const sourceKeys = Array.isArray(node.sourceKeys) ? node.sourceKeys : [];
  if (sourceKeys.length > 0 && !sourceKeys.includes(item.sourceModuleKey)) {
    weighted -= 2.5;
  } else if (sourceKeys.includes(item.sourceModuleKey)) {
    weighted += 0.8;
  }
  const pathRule = PATH_RULES[node.pathLabel];
  if (pathRule?.include && pathRule.include.test(text)) weighted += 3.2;
  if (pathRule?.exclude && pathRule.exclude.test(text)) weighted -= 4.5;
  return weighted;
}

function pickCandidateNodes(item, nodes, nodeTokenMap, k = 6) {
  const ranked = nodes
    .map((n) => ({ node: n, score: heuristicScore(item, n, nodeTokenMap) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, k);
  return top.map((x) => x.node);
}

async function classifyBatchWithOpenAI(openai, model, batch, candidatesPerItem) {
  const schemaHelp = batch.map((it, idx) => ({
    index: idx,
    text: it.text,
    sourceHint: `${it.sourceModuleKey} / ${it.sourceChecklistTitle} / ${it.sourceSection}`,
    candidates: candidatesPerItem[idx].map((c) => c.pathLabel)
  }));

  const system = [
    'You are classifying checklist items to the best module/submodule in a charity compliance platform.',
    'Return STRICT JSON with key "results" only.',
    'For each input index, pick exactly one candidate path.',
    'Be conservative: prioritize semantic fit and regulatory context.',
    'Output format: {"results":[{"index":0,"path":"...","confidence":0.0-1.0,"reason":"short"}]}'
  ].join(' ');

  const user = JSON.stringify({ items: schemaHelp });

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  return results;
}

function assignByPathLabel(pathLabel, nodes) {
  return nodes.find((n) => n.pathLabel === pathLabel) || null;
}

function keepByPathRule(pathLabel, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const pathRule = PATH_RULES[pathLabel];
  if (pathRule?.exclude && pathRule.exclude.test(t)) return false;
  if (pathRule?.include && !pathRule.include.test(t)) {
    // strict include for curated noisy nodes
    if (
      pathLabel === 'GOVERNANCE > Charity Administration > Yearly Statements' ||
      pathLabel === 'GOVERNANCE > Policies & Procedures' ||
      pathLabel === 'FUNDING > Grants & Donors > Donor Register' ||
      pathLabel === 'REPORTING > Weekly Reports'
    ) return false;
  }
  if (pathLabel.includes('Responsible People')) {
    return /(responsible person|board member|director|trustee|wwcc|working with children|police check|fit and proper|consent)/.test(t);
  }
  if (pathLabel.includes('> Volunteers')) {
    return /(volunteer|volunteering|volunteer coordinator|volunteer application|volunteer handbook)/.test(t);
  }
  if (pathLabel.includes('> People & HR > Employees')) {
    return /(employee|staff|employment|hr|offboarding|personnel)/.test(t);
  }
  if (pathLabel.includes('> People & HR > Trainings')) {
    return /(training|induction|workshop|course|learning|competency)/.test(t);
  }
  if (pathLabel.includes('> People & HR > Training Register')) {
    return /(training register|training record|competency|completion|training)/.test(t);
  }
  return true;
}

function forcedPathByRule(item) {
  const text = `${item?.text || ''} ${item?.sourceChecklistTitle || ''} ${item?.sourceSection || ''}`.toLowerCase();
  // Policy governance lines should be forced into Policies & Procedures, not Responsible People.
  if (/policy/.test(text) && /(board approval|approved by the board|policy documentation|policy review|policy has been reviewed)/.test(text)) {
    return 'GOVERNANCE > Policies & Procedures';
  }
  // COI declarations should be kept in Conflict of Interest.
  if (/(conflict of interest|coi|declaration of interest)/.test(text)) {
    return 'GOVERNANCE > Conflict of Interest';
  }
  // Donor/fundraising campaign lines should avoid people/board buckets.
  if (/(donor|fundraising campaign|marketing campaign|social media)/.test(text)) {
    return 'FUNDING > Grants & Donors > Donor Register';
  }
  // Training lines should go to training buckets.
  if (/(training register|training record|competency matrix)/.test(text)) {
    return 'OPERATIONS > People & HR > Training Register';
  }
  if (/(training|induction|workshop|course|learning program)/.test(text)) {
    return 'OPERATIONS > People & HR > Trainings';
  }
  return null;
}

function makeOutputFromAssignments(template, assignmentsByNodeId, nodes, diagnostics) {
  const out = JSON.parse(JSON.stringify(template));
  // clear existing items
  for (const [sectionName, sectionNode] of Object.entries(out || {})) {
    if (sectionName === '_meta' || !sectionNode || typeof sectionNode !== 'object') continue;
    for (const [moduleName, moduleNode] of Object.entries(sectionNode || {})) {
      if (Array.isArray(moduleNode?.items)) {
        moduleNode.items = [];
        moduleNode.item_count = 0;
      } else {
        for (const [, subNode] of Object.entries(moduleNode || {})) {
          if (Array.isArray(subNode?.items)) {
            subNode.items = [];
            subNode.item_count = 0;
          }
        }
      }
    }
  }

  for (const node of nodes) {
    const assigned = assignmentsByNodeId.get(node.id) || [];
    const unique = [];
    const seen = new Set();
    for (const a of assigned) {
      const t = cleanText(a?.text);
      if (!t) continue;
      if (!keepByPathRule(node.pathLabel, t)) continue;
      const low = t.toLowerCase();
      if (seen.has(low)) continue;
      seen.add(low);
      unique.push(t);
    }
    if (node.submoduleName) {
      const subNode = out?.[node.sectionName]?.[node.moduleName]?.[node.submoduleName];
      if (subNode) {
        subNode.items = unique;
        subNode.item_count = unique.length;
      }
    } else {
      const modNode = out?.[node.sectionName]?.[node.moduleName];
      if (modNode && Array.isArray(modNode.items)) {
        modNode.items = unique;
        modNode.item_count = unique.length;
      }
    }
  }

  out._meta = {
    ...(out._meta || {}),
    intelligent_remap: {
      generated_at: new Date().toISOString(),
      method: diagnostics.method,
      model: diagnostics.model,
      total_items_classified: diagnostics.totalItems,
      node_count: diagnostics.nodeCount,
      avg_confidence: diagnostics.avgConfidence,
      note: 'Items re-mapped by intelligent classifier; review low-confidence nodes manually.'
    }
  };

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRaw = JSON.parse(await fs.readFile(SOURCE_PATH, 'utf8'));
  const targetRaw = JSON.parse(await fs.readFile(TARGET_PATH, 'utf8'));
  const guideRaw = await fs.readFile(GUIDE_PATH, 'utf8').catch(() => '');
  const guideKeywordMap = parseGuideKeywordsMap(guideRaw);
  const allItems = flattenSourceDictionary(sourceRaw);
  const items = args.limit ? allItems.slice(0, args.limit) : allItems;
  const nodes = extractTargetNodes(targetRaw);
  const nodeTokenMap = new Map(nodes.map((n) => [n.id, nodeKeywords(n, guideKeywordMap)]));

  const assignmentsByNodeId = new Map(nodes.map((n) => [n.id, []]));
  const perItemConfidence = [];

  const canUseOpenAI = !!process.env.OPENAI_API_KEY;
  const openai = canUseOpenAI ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  for (let i = 0; i < items.length; i += args.batch) {
    const batch = items.slice(i, i + args.batch);
    const candidatesPerItem = batch.map((it) => pickCandidateNodes(it, nodes, nodeTokenMap, 6));

    // Apply deterministic overrides first for high-precision routing.
    const unresolved = [];
    const unresolvedCandidates = [];
    batch.forEach((item, idx) => {
      const forcedPath = forcedPathByRule(item);
      if (forcedPath) {
        const forcedNode = assignByPathLabel(forcedPath, nodes);
        if (forcedNode) {
          assignmentsByNodeId.get(forcedNode.id)?.push(item);
          perItemConfidence.push(0.95);
          return;
        }
      }
      unresolved.push({ item, idx });
      unresolvedCandidates.push(candidatesPerItem[idx]);
    });

    if (unresolved.length === 0) {
      continue;
    }

    if (openai) {
      try {
        const unresolvedBatch = unresolved.map((u) => u.item);
        const classified = await classifyBatchWithOpenAI(openai, args.model, unresolvedBatch, unresolvedCandidates);
        for (const row of classified) {
          const idx = Number(row?.index);
          if (!Number.isFinite(idx) || idx < 0 || idx >= unresolved.length) continue;
          const item = unresolved[idx].item;
          const node = assignByPathLabel(String(row?.path || ''), unresolvedCandidates[idx]) || unresolvedCandidates[idx][0];
          if (!node) continue;
          assignmentsByNodeId.get(node.id)?.push(item);
          perItemConfidence.push(Number(row?.confidence) || 0.5);
        }
        // fallback for missing indices
        const got = new Set(classified.map((r) => Number(r?.index)).filter((x) => Number.isFinite(x)));
        unresolved.forEach(({ item }, idx) => {
          if (got.has(idx)) return;
          const node = unresolvedCandidates[idx][0];
          if (!node) return;
          assignmentsByNodeId.get(node.id)?.push(item);
          perItemConfidence.push(0.45);
        });
      } catch {
        // API failure fallback to heuristics for this batch
        unresolved.forEach(({ item }, idx) => {
          const node = unresolvedCandidates[idx][0];
          if (!node) return;
          assignmentsByNodeId.get(node.id)?.push(item);
          perItemConfidence.push(0.35);
        });
      }
    } else {
      // heuristic-only mode
      unresolved.forEach(({ item }, idx) => {
        const node = unresolvedCandidates[idx][0];
        if (!node) return;
        assignmentsByNodeId.get(node.id)?.push(item);
        perItemConfidence.push(0.3);
      });
    }
  }

  const avgConfidence = perItemConfidence.length
    ? Number((perItemConfidence.reduce((a, b) => a + b, 0) / perItemConfidence.length).toFixed(3))
    : 0;

  const diagnostics = {
    method: canUseOpenAI ? 'openai+heuristic-fallback' : 'heuristic-only',
    model: canUseOpenAI ? args.model : 'n/a',
    totalItems: items.length,
    nodeCount: nodes.length,
    avgConfidence
  };

  const output = makeOutputFromAssignments(targetRaw, assignmentsByNodeId, nodes, diagnostics);
  if (!args.dryRun) {
    await fs.writeFile(TARGET_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }

  console.log(`Source items: ${items.length}`);
  console.log(`Target nodes: ${nodes.length}`);
  console.log(`Mode: ${diagnostics.method}`);
  console.log(`Avg confidence: ${avgConfidence}`);
  console.log(args.dryRun ? 'Dry run only (no file write).' : `Updated: ${TARGET_PATH}`);
}

main().catch((err) => {
  console.error('Checklist intelligent remap failed:', err?.message || err);
  process.exit(1);
});

