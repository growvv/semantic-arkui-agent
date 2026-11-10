#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TS = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript';
const ts = require(process.env.ARKTS_TS_PATH || DEFAULT_TS);

const UI_COMPONENTS = new Set([
  'Button', 'Text', 'TextInput', 'TextArea', 'Search', 'Image', 'SymbolGlyph',
  'Slider', 'Toggle', 'Checkbox', 'Radio', 'List', 'ListItem', 'Scroll',
  'Grid', 'GridItem', 'Tabs', 'TabContent', 'Swiper', 'Row', 'Column',
  'Stack', 'Flex', 'RelativeContainer', 'WaterFlow', 'FlowItem', 'Progress',
  'Badge', 'Divider', 'Blank', 'Line', 'Circle', 'Path', 'Shape', 'Canvas',
  'Video', 'Web',
]);

const NON_UI = new Set([
  'Date', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON',
  'Set', 'Map', 'Promise', 'RegExp', 'Error', 'Symbol', 'Intl', 'BigInt',
  'Uint8Array', 'ArrayBuffer', 'Resource', 'Color', 'FontWeight', 'Alignment',
  'ForEach', 'LazyForEach', 'If', 'Repeat', 'State', 'Prop', 'Link', 'Builder',
  'Entry', 'Component', 'Watch', 'Provide', 'Consume', 'StorageProp',
  'StorageLink', 'ObjectLink', 'Observed', 'Require', 'Preview',
]);

const CONTAINERS = new Set([
  'Row', 'Column', 'Stack', 'Flex', 'RelativeContainer', 'List', 'ListItem',
  'WaterFlow', 'FlowItem', 'Grid', 'GridItem', 'Scroll', 'Swiper', 'Tabs',
  'TabContent',
]);

function isUiName(name) {
  if (!name) return false;
  if (UI_COMPONENTS.has(name)) return true;
  if (NON_UI.has(name)) return false;
  return /^[A-Z]/.test(name);
}

function walkEts(root) {
  const files = [];
  const skip = new Set(['oh_modules', 'node_modules', 'build', '.hvigor', 'libs']);
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.ets')) files.push(full);
    }
  };
  visit(root);
  return files;
}

function calleeName(node) {
  const expression = node.expression;
  if (!expression) return '';
  if (ts.isIdentifier(expression)) return expression.text;
  return '';
}

function collectModifiers(node, source) {
  const modifiers = [];
  let current = node;
  while (current.parent && ts.isPropertyAccessExpression(current.parent) && current.parent.parent && ts.isCallExpression(current.parent.parent)) {
    modifiers.push(current.parent.name.getText(source));
    current = current.parent.parent;
  }
  return modifiers;
}

function containerStart(text, end) {
  let index = end;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return text[index] === '{';
}

function lineSnippet(text, start, line) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = text.indexOf('\n', start);
  const prefix = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return prefix.trim().slice(0, 240);
}

function scanText(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.ETS);
  const candidates = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && isUiName(name)) {
        const start = node.getStart(source);
        const end = node.getEnd();
        const position = source.getLineAndCharacterOfPosition(start);
        candidates.push({
          file,
          line: position.line + 1,
          column: position.character + 1,
          component: name,
          args: node.arguments.map((argument) => argument.getText(source).slice(0, 160)),
          modifiers: collectModifiers(node, source),
          start,
          end,
          container: containerStart(text, end),
          snippet: lineSnippet(text, start, position.line),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return candidates;
}

function scanProject(project) {
  const roots = [path.join(project, 'entry/src/main/ets'), path.join(project, 'entry/src/main')];
  const root = roots.find((candidate) => fs.existsSync(candidate)) || project;
  const files = walkEts(root);
  const candidates = [];
  for (const file of files) {
    try {
      candidates.push(...scanText(file, fs.readFileSync(file, 'utf8')));
    } catch (error) {
      candidates.push({ file, error: error.message });
    }
  }
  return { project, root, files: files.length, candidates };
}

function literalText(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('$r(')) {
    const match = trimmed.match(/\$r\(['"](?:app\.string\.)?([^'"]+)['"]\)/);
    if (match) {
      return match[1].replace(/^(Settings|General|Add|Work|Card|Data|UI)_/, '').replace(/_/g, ' ');
    }
  }
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.includes('${')) {
    return trimmed.slice(1, -1);
  }
  return trimmed.slice(0, 80);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';
}

function ruleProposal(candidate, index) {
  const component = candidate.component;
  const modifiers = candidate.modifiers || [];
  const onClick = modifiers.includes('onClick') || modifiers.includes('onTouch');
  const name = component.toLowerCase();
  const firstText = literalText((candidate.args || [])[0] || '');
  const idSuffix = `${slug(component)}-${candidate.line}`;
  const id = `sem.auto.${idSuffix}`;
  const base = {
    candidateIndex: index,
    file: candidate.file,
    line: candidate.line,
    component,
    id,
    idSuffix,
    source: 'rule',
    confidence: 0.62,
    annotate: true,
    role: 'content',
    meaning: firstText || `${component} 控件`,
    actions: [],
  };
  if (component === 'TextInput' || component === 'TextArea' || component === 'Search') {
    return { ...base, role: 'input', meaning: firstText || '文本输入框', actions: [{ name: 'set_text', input: 'set_text', label: '输入文本' }] };
  }
  if (component === 'Slider') {
    return { ...base, role: 'control', meaning: firstText || '滑块', actions: [{ name: 'tap', input: 'tap', label: '调整滑块' }] };
  }
  if (component === 'Toggle' || component === 'Checkbox' || component === 'Radio') {
    return { ...base, role: 'toggle', meaning: firstText || '开关', actions: [{ name: 'tap', input: 'tap', label: '切换状态' }] };
  }
  if (onClick || component === 'Button' || /^[A-Z]/.test(component) && !UI_COMPONENTS.has(component)) {
    return { ...base, role: 'action', meaning: firstText || `${component} 操作`, actions: [{ name: 'tap', input: 'tap', label: '点击' }] };
  }
  if (CONTAINERS.has(component)) {
    return { ...base, annotate: false, role: 'group', meaning: `${component} 布局容器`, confidence: 0.4, reason: 'layout container without an explicit interaction' };
  }
  return base;
}

function promptFor(candidates) {
  const compact = candidates.map((candidate, index) => ({
    index,
    component: candidate.component,
    args: candidate.args,
    modifiers: candidate.modifiers,
    snippet: candidate.snippet,
  }));
  return [
    'You annotate ArkUI components for a text-only UI agent. For each candidate decide whether to annotate.',
    'Return JSON: {"proposals":[{"index":0,"annotate":true,"role":"action|input|toggle|control|content|list","id_suffix":"short-name","meaning":"what it is and what it represents","actions":[{"name":"tap","input":"tap|set_text|scroll","label":"user-facing action"}],"confidence":0.0}]}',
    'Skip layout-only containers. Do not invent business data that is not visible in the snippet. Use Chinese meanings when the snippet is Chinese.',
    JSON.stringify({ candidates: compact }),
  ].join('\n');
}

async function proposeWithLlm(candidates, limit) {
  const batch = candidates.slice(0, limit);
  if (batch.length === 0) return { proposals: [], error: '' };
  try {
    const response = await fetch(process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.SEMANTIC_MODEL || 'auto/gpt-6-luna',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an ArkUI semantic annotation assistant. Return JSON only.' },
          { role: 'user', content: promptFor(batch) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`magpie HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (!content) throw new Error('empty model response');
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : Array.isArray(parsed.results) ? parsed.results : [];
    return { proposals, error: '' };
  } catch (error) {
    return { proposals: [], error: error.message };
  }
}

async function propose(project, options) {
  const scan = scanProject(project);
  const rules = scan.candidates.map((candidate, index) => ruleProposal(candidate, index));
  const llm = await proposeWithLlm(scan.candidates, options.llmLimit);
  const byIndex = new Map();
  for (const proposal of llm.proposals) {
    if (proposal && Number.isInteger(proposal.index)) byIndex.set(proposal.index, proposal);
  }
  const proposals = rules.map((rule, index) => {
    const model = byIndex.get(index);
    if (!model || model.annotate === false) return rule;
    const idSuffix = model.id_suffix ? slug(model.id_suffix) : rule.idSuffix;
    return {
      ...rule,
      source: 'llm',
      annotate: model.annotate !== false,
      role: model.role || rule.role,
      id: `sem.auto.${idSuffix}`,
      idSuffix,
      meaning: model.meaning || rule.meaning,
      actions: Array.isArray(model.actions) ? model.actions : rule.actions,
      confidence: typeof model.confidence === 'number' ? model.confidence : 0.7,
    };
  });
  const report = {
    project: scan.project,
    sourceRoot: scan.root,
    files: scan.files,
    candidateCount: scan.candidates.length,
    llmError: llm.error,
    llmProposed: llm.proposals.length,
    proposals,
    candidates: scan.candidates.map((candidate, index) => ({ index, ...candidate })),
  };
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(path.resolve(options.out), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}

function applyProposalToText(text, candidate, proposal, importPath) {
  if (!proposal || proposal.annotate === false) return { text, changed: false, reason: 'not annotated' };
  if (candidate.container) return { text, changed: false, reason: 'component has a trailing child block' };
  const id = proposal.id || 'sem.auto.node';
  const meaning = String(proposal.meaning || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const actions = Array.isArray(proposal.actions) ? proposal.actions : [];
  const actionText = actions.map((action) => `{ name: '${action.name || 'tap'}', input: '${action.input || 'tap'}', label: '${String(action.label || '').replace(/'/g, "\\'")}' }`).join(', ');
  const spec = `{\n    schema: 1,\n    id: '${id}',\n    role: '${proposal.role || 'action'}',\n    meaning: '${meaning}',\n    actions: [${actionText}],\n    risk: 'read_only'\n  }`;
  const insertion = `\n    .id('${id}')\n    .customProperty('sem', Sem.node(${spec}))`;
  let output = text.slice(0, candidate.end) + insertion + text.slice(candidate.end);
  const importLine = `import { Sem } from '${importPath}';`;
  if (importPath && !output.includes("from '" + importPath + "'")) {
    const importEnd = output.lastIndexOf('\nimport ');
    const insertAt = importEnd >= 0 ? output.indexOf('\n', importEnd + 1) + 1 : 0;
    output = output.slice(0, insertAt) + importLine + '\n' + output.slice(insertAt);
  }
  return { text: output, changed: true, reason: 'inserted id and customProperty' };
}

function parseArgs(argv) {
  const args = { command: argv[0] || '', options: new Map() };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args.options.set(key, next);
        index += 1;
      } else {
        args.options.set(key, 'true');
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const option = (key, fallback) => args.options.get(key) || fallback;
  if (args.command === 'scan') {
    const result = scanProject(option('project', process.cwd()));
    if (option('out', '')) {
      fs.writeFileSync(path.resolve(option('out')), JSON.stringify(result, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify({ files: result.files, candidates: result.candidates.length, out: option('out', '') }, null, 2));
    return;
  }
  if (args.command === 'propose') {
    const report = await propose(option('project', process.cwd()), {
      out: option('out', ''),
      llmLimit: Number(option('llm-limit', '8')),
    });
    console.log(JSON.stringify({ files: report.files, candidates: report.candidateCount, llmError: report.llmError, llmProposed: report.llmProposed, out: option('out', '') }, null, 2));
    return;
  }
  if (args.command === 'apply') {
    const file = option('file', '');
    const proposalId = option('id', '');
    const reportPath = option('proposals', '');
    const text = fs.readFileSync(file, 'utf8');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const proposal = report.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new Error(`proposal ${proposalId} not found`);
    const candidate = report.candidates.find((item) => item.index === proposal.candidateIndex);
    if (!candidate) throw new Error(`candidate ${proposal.candidateIndex} not found`);
    const relative = path.relative(path.dirname(file), path.join(option('project', ''), 'entry/src/main/ets/semantics/Sem')).replace(/\\/g, '/');
    const importPath = relative.startsWith('.') ? relative : './' + relative;
    const result = applyProposalToText(text, candidate, proposal, importPath);
    if (option('dry-run', 'false') === 'true') {
      console.log(JSON.stringify({ changed: result.changed, reason: result.reason, preview: result.text.slice(Math.max(0, candidate.start - 80), candidate.end + 260) }, null, 2));
    } else {
      fs.writeFileSync(file, result.text, 'utf8');
      console.log(JSON.stringify({ changed: result.changed, reason: result.reason }, null, 2));
    }
    return;
  }
  console.error('Usage: cli.js scan|propose|apply --project <dir> [--out <file>]');
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { scanProject, scanText, ruleProposal, propose, applyProposalToText };
