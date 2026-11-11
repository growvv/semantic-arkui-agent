#!/usr/bin/env node
'use strict';

/**
 * Verify that a semantic annotation only adds hidden information.
 *
 * The contract: an annotated app must keep its original UI and behaviour. Only
 * `.id`, `.accessibilityText`, `.accessibilityDescription` and
 * `.customProperty('sem', ...)` may be added, plus the `Sem` import. Anything
 * that changes layout, text, visibility or event handling fails the check.
 *
 * Usage:
 *   node tools/annotation-audit/cli.js --baseline <dir> --annotated <dir> [--out <file>]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TS = '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/ets/build-tools/ets-loader/node_modules/typescript';
const ts = require(process.env.ARKTS_TS_PATH || DEFAULT_TS);

// Modifiers that carry semantics without touching layout or behaviour.
const ALLOWED_MODIFIERS = new Set(['id', 'accessibilityText', 'accessibilityDescription', 'customProperty']);

// Modifiers that change what the user sees or what the app does.
const BEHAVIOUR_MODIFIERS = new Set([
  'onClick', 'onTouch', 'onAppear', 'onDisAppear', 'onAreaChange', 'onVisibleAreaChange',
  'gesture', 'priorityGesture', 'parallelGesture', 'bindSheet', 'bindMenu', 'bindPopup',
  'bindContextMenu', 'focusable', 'defaultFocus', 'enabled', 'hitTestBehavior',
]);

const LAYOUT_MODIFIERS = new Set([
  'width', 'height', 'size', 'constraintSize', 'layoutWeight', 'padding', 'margin',
  'position', 'offset', 'markAnchor', 'align', 'alignRules', 'visibility', 'displayPriority',
  'flexGrow', 'flexShrink', 'flexBasis', 'aspectRatio', 'direction', 'zIndex', 'opacity',
  'backgroundColor', 'backgroundImage', 'border', 'borderRadius', 'fontSize', 'fontColor',
  'fontWeight', 'fontFamily', 'textAlign', 'textOverflow', 'maxLines', 'lineHeight',
]);

const SKIP_DIRS = new Set(['oh_modules', 'node_modules', 'build', '.hvigor', 'libs', '.preview', '.git']);

function walkEts(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.ets')) files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

function sourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.ETS);
}

/**
 * Collect `.modifier(...)` calls that sit on an ArkUI component chain.
 * Helper calls such as `Sem.node(...)` are not UI modifiers and must not be
 * counted, otherwise every compliant annotation looks like a new modifier.
 */
function collectModifiers(sf) {
  const found = [];

  // Walk down a property-access/call chain to its root expression. Arguments are
  // never traversed, so a nested `Sem.node({...})` cannot truncate the chain.
  const chainRoot = (node) => {
    let current = node;
    for (;;) {
      if (ts.isPropertyAccessExpression(current)) { current = current.expression; continue; }
      if (ts.isCallExpression(current)) { current = current.expression; continue; }
      return current;
    }
  };

  // ArkUI modifiers are a known vocabulary. Matching on the name keeps the
  // audit independent of how the ETS parser shapes a chain: a trailing child
  // block (`Column() { ... }.padding(16)`) does not parse as a plain call
  // chain, and a helper call (`Sem.node({...})`) must not count as a modifier.
  const KNOWN = new Set([...ALLOWED_MODIFIERS, ...BEHAVIOUR_MODIFIERS, ...LAYOUT_MODIFIERS]);

  const record = (name, node) => {
    if (!KNOWN.has(name)) return;
    found.push({
      name,
      args: node.arguments.map((arg) => arg.getText(sf)),
      start: node.getStart(sf),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        record(node.expression.name.getText(sf), node);
      } else if (ts.isIdentifier(node.expression)) {
        // A modifier on a container with a trailing child block
        // (`Column() { ... }.padding(16)`) parses as a bare call `padding(16)`.
        record(node.expression.text, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Collect string literals that reach the screen: component text arguments. */
function collectVisibleText(sf) {
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (/^[A-Z]/.test(name)) {
        for (const arg of node.arguments) {
          if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
            found.push({ component: name, text: arg.text });
          } else if (ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const key = prop.name.getText(sf);
              if (!['placeholder', 'text', 'label', 'title', 'content'].includes(key)) continue;
              const value = prop.initializer;
              if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
                found.push({ component: name, text: value.text });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Collect @State/@Prop/... declarations and lifecycle callbacks. */
function collectDeclarations(sf) {
  const state = [];
  const lifecycle = [];
  const visit = (node) => {
    if (ts.isPropertyDeclaration(node)) {
      const decorators = ts.getDecorators ? ts.getDecorators(node) : node.decorators;
      if (decorators) {
        for (const decorator of decorators) {
          const text = decorator.getText(sf);
          if (/^@(State|Prop|Link|Provide|Consume|StorageProp|StorageLink|ObjectLink|Watch)/.test(text)) {
            state.push(`${text} ${node.name.getText(sf)}`);
          }
        }
      }
    }
    if (ts.isMethodDeclaration(node)) {
      const name = node.name.getText(sf);
      if (['aboutToAppear', 'aboutToDisappear', 'onPageShow', 'onPageHide', 'onBackPress', 'build'].includes(name)) {
        lifecycle.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { state, lifecycle };
}

function countBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const value = typeof key === 'function' ? key(item) : item[key];
    map.set(value, (map.get(value) || 0) + 1);
  }
  return map;
}

function diffCounts(before, after) {
  const added = [];
  const removed = [];
  for (const [key, count] of after) {
    const previous = before.get(key) || 0;
    if (count > previous) added.push({ key, count: count - previous });
  }
  for (const [key, count] of before) {
    const current = after.get(key) || 0;
    if (count > current) removed.push({ key, count: count - current });
  }
  return { added, removed };
}

/**
 * Compare one file before and after annotation.
 * Returns findings; an empty list means the annotation stayed inside the contract.
 */
function auditFile(relative, baselineText, annotatedText) {
  const findings = [];
  const before = sourceFile(relative, baselineText);
  const after = sourceFile(relative, annotatedText);

  const beforeMods = collectModifiers(before);
  const afterMods = collectModifiers(after);
  const modDiff = diffCounts(countBy(beforeMods, 'name'), countBy(afterMods, 'name'));

  for (const { key, count } of modDiff.added) {
    if (ALLOWED_MODIFIERS.has(key)) continue;
    const kind = BEHAVIOUR_MODIFIERS.has(key) ? 'behaviour' : LAYOUT_MODIFIERS.has(key) ? 'layout' : 'unknown-modifier';
    findings.push({
      file: relative,
      kind,
      detail: `added .${key}() x${count}`,
      hint: kind === 'behaviour'
        ? 'Event handling changed. Declare passthrough on the host instead of adding a handler.'
        : 'Only id/accessibilityText/accessibilityDescription/customProperty may be added.',
    });
  }
  for (const { key, count } of modDiff.removed) {
    findings.push({
      file: relative,
      kind: 'removed-modifier',
      detail: `removed .${key}() x${count}`,
      hint: 'Annotation must not remove existing modifiers.',
    });
  }

  // A modifier that already existed must keep its arguments. Compare the full
  // name+args signature so `.width(120)` -> `.width(140)` is caught even though
  // the modifier name itself is unchanged.
  const signature = (m) => `${m.name}:${m.args.join('|')}`;
  const beforeSignatures = countBy(beforeMods, signature);
  const afterSignatures = countBy(afterMods, signature);
  const changedNames = new Set([...modDiff.added, ...modDiff.removed].map((d) => d.key));
  for (const { key } of diffCounts(beforeSignatures, afterSignatures).removed) {
    const name = key.split(':')[0];
    // Additions/removals of a whole modifier are already reported above.
    if (changedNames.has(name)) continue;
    const kind = BEHAVIOUR_MODIFIERS.has(name) ? 'behaviour' : LAYOUT_MODIFIERS.has(name) ? 'layout' : 'changed-allowed-modifier';
    findings.push({
      file: relative,
      kind,
      detail: `existing .${name}() argument changed`,
      hint: 'Keep the original arguments; add a new call instead of editing an existing one.',
    });
  }

  const textDiff = diffCounts(
    countBy(collectVisibleText(before), (t) => `${t.component}:${t.text}`),
    countBy(collectVisibleText(after), (t) => `${t.component}:${t.text}`),
  );
  for (const { key, count } of textDiff.added) {
    // A hidden summary node is allowed only when it is an empty string.
    const value = key.slice(key.indexOf(':') + 1);
    if (value === '') continue;
    findings.push({
      file: relative,
      kind: 'visible-text',
      detail: `added visible text "${value}" x${count}`,
      hint: 'Semantic meaning belongs in customProperty, not in rendered text.',
    });
  }
  for (const { key, count } of textDiff.removed) {
    findings.push({
      file: relative,
      kind: 'visible-text',
      detail: `removed visible text "${key.slice(key.indexOf(':') + 1)}" x${count}`,
      hint: 'Annotation must not remove rendered text.',
    });
  }

  const beforeDecl = collectDeclarations(before);
  const afterDecl = collectDeclarations(after);
  for (const { key, count } of diffCounts(countBy(beforeDecl.state, (s) => s), countBy(afterDecl.state, (s) => s)).added) {
    findings.push({
      file: relative,
      kind: 'state',
      detail: `added ${key} x${count}`,
      hint: 'Annotation must not introduce app state.',
    });
  }
  for (const { key, count } of diffCounts(countBy(beforeDecl.lifecycle, (s) => s), countBy(afterDecl.lifecycle, (s) => s)).added) {
    if (key === 'aboutToAppear' || key === 'aboutToDisappear') continue; // bridge start/stop lives here
    findings.push({
      file: relative,
      kind: 'lifecycle',
      detail: `added ${key}() x${count}`,
      hint: 'Only the bridge start/stop may be added to a lifecycle callback.',
    });
  }

  return findings;
}

function auditProject(baselineRoot, annotatedRoot) {
  const baselineFiles = walkEts(baselineRoot);
  const annotatedFiles = walkEts(annotatedRoot);
  const rel = (root, file) => path.relative(root, file);
  const baselineSet = new Set(baselineFiles.map((f) => rel(baselineRoot, f)));
  const annotatedSet = new Set(annotatedFiles.map((f) => rel(annotatedRoot, f)));

  const findings = [];
  const audited = [];
  const addedFiles = [];
  const removedFiles = [];

  for (const file of annotatedSet) {
    if (!baselineSet.has(file)) addedFiles.push(file);
  }
  for (const file of baselineSet) {
    if (!annotatedSet.has(file)) removedFiles.push(file);
  }
  for (const file of removedFiles) {
    findings.push({ file, kind: 'removed-file', detail: 'source file removed', hint: 'Annotation must not delete app sources.' });
  }

  for (const file of [...annotatedSet].sort()) {
    const annotatedText = fs.readFileSync(path.join(annotatedRoot, file), 'utf8');
    if (!baselineSet.has(file)) {
      // New files are allowed only for the semantics helper/bridge themselves.
      const segments = file.split(/[\\/]/);
      if (segments.includes('semantics')) continue;
      findings.push({
        file,
        kind: 'added-file',
        detail: 'new source file outside semantics/',
        hint: 'Only the semantics helper and bridge may be added as new files.',
      });
      continue;
    }
    const baselineText = fs.readFileSync(path.join(baselineRoot, file), 'utf8');
    if (baselineText === annotatedText) continue;
    audited.push(file);
    findings.push(...auditFile(file, baselineText, annotatedText));
  }

  return {
    baselineRoot,
    annotatedRoot,
    baselineFiles: baselineFiles.length,
    annotatedFiles: annotatedFiles.length,
    changedFiles: audited.length,
    addedFiles,
    removedFiles,
    findings,
    ok: findings.length === 0,
  };
}

function parseArgs(argv) {
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { options.set(key, next); i++; }
    else options.set(key, 'true');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseline = options.get('baseline');
  const annotated = options.get('annotated');
  if (!baseline || !annotated) {
    console.error('Usage: cli.js --baseline <dir> --annotated <dir> [--out <file>]');
    process.exit(2);
  }
  const report = auditProject(baseline, annotated);
  const json = JSON.stringify(report, null, 2) + '\n';
  const out = options.get('out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, 'utf8');
  }
  if (report.ok) {
    console.log(`ANNOTATION_AUDIT_OK changedFiles=${report.changedFiles} addedFiles=${report.addedFiles.length}`);
  } else {
    console.log(`ANNOTATION_AUDIT_FAIL findings=${report.findings.length}`);
    for (const finding of report.findings) {
      console.log(`  [${finding.kind}] ${finding.file}: ${finding.detail}`);
    }
  }
  if (!out) process.stdout.write(json);
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { auditFile, auditProject, collectModifiers, collectVisibleText };
