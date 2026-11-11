#!/usr/bin/env node
'use strict';

/**
 * Selftest for the annotation audit: a compliant annotation must pass, and each
 * violation class must be caught. Without this, "zero UI/logic change" is a
 * promise instead of a check.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditFile, auditProject } = require('./cli');

const baseline = `import { router } from '@kit.ArkUI';

@Entry
@Component
struct Index {
  @State count: number = 0

  build() {
    Column() {
      Text('Hello')
        .fontSize(20)
      Button('Tap me')
        .width(120)
        .onClick(() => {
          this.count += 1
        })
    }
    .padding(16)
  }
}
`;

function check(name, annotated, expectedKinds) {
  const findings = auditFile('Index.ets', baseline, annotated);
  const kinds = [...new Set(findings.map((f) => f.kind))].sort();
  const expected = [...expectedKinds].sort();
  const ok = JSON.stringify(kinds) === JSON.stringify(expected);
  if (!ok) {
    throw new Error(`${name}: expected [${expected}] got [${kinds}] ${JSON.stringify(findings)}`);
  }
  return findings;
}

// 1. Compliant: only id + customProperty + accessibility text are added.
check('compliant', baseline.replace(
  `      Button('Tap me')
        .width(120)`,
  `      Button('Tap me')
        .id('sem.tap')
        .accessibilityText('点击增加计数')
        .customProperty('sem', Sem.node({ schema: 1, id: 'sem.tap', role: 'action', meaning: '增加计数' }))
        .width(120)`,
), []);

// 2. Adding a handler is a behaviour change.
check('added-onClick', baseline.replace(
  `      Text('Hello')
        .fontSize(20)`,
  `      Text('Hello')
        .fontSize(20)
        .onClick(() => {})`,
), ['behaviour']);

// 3. Changing layout is a layout change.
check('added-visibility', baseline.replace(
  `    .padding(16)`,
  `    .padding(16)
    .visibility(Visibility.None)`,
), ['layout']);

// 4. Changing rendered text is a visible-text change.
check('changed-text', baseline.replace(`Text('Hello')`, `Text('Semantic Hello')`), ['visible-text']);

// 5. Introducing state is a state change.
check('added-state', baseline.replace(
  `  @State count: number = 0`,
  `  @State count: number = 0
  @State semReady: boolean = false`,
), ['state']);

// 6. Removing an existing modifier is caught.
check('removed-modifier', baseline.replace(`        .width(120)\n`, ''), ['removed-modifier']);

// 7. Editing an existing allowed modifier's argument is caught.
check('changed-allowed', baseline.replace(
  `      Button('Tap me')`,
  `      Button('Tap me')
        .id('sem.changed')`,
).replace(`        .width(120)`, `        .width(140)`), ['layout']);

// 8. A hidden empty summary node is allowed.
check('hidden-summary', baseline.replace(
  `      Text('Hello')`,
  `      Text('')
        .id('sem.summary')
        .visibility(Visibility.None)
        .customProperty('sem', Sem.node({ schema: 1, id: 'sem.summary', role: 'content', meaning: '计数' }))
      Text('Hello')`,
), ['layout']);

// Project-level: new files outside semantics/ are rejected, semantics/ is allowed.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-audit-'));
try {
  const baseDir = path.join(root, 'baseline');
  const annDir = path.join(root, 'annotated');
  fs.mkdirSync(path.join(baseDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(annDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(annDir, 'semantics'), { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'pages/Index.ets'), baseline);
  fs.writeFileSync(path.join(annDir, 'pages/Index.ets'), baseline);
  fs.writeFileSync(path.join(annDir, 'semantics/Sem.ets'), 'export class Sem {}\n');

  const okReport = auditProject(baseDir, annDir);
  if (!okReport.ok) throw new Error(`semantics-only addition should pass: ${JSON.stringify(okReport.findings)}`);

  fs.writeFileSync(path.join(annDir, 'pages/Extra.ets'), baseline);
  const badReport = auditProject(baseDir, annDir);
  if (badReport.ok || !badReport.findings.some((f) => f.kind === 'added-file')) {
    throw new Error('new page file should be rejected');
  }

  fs.rmSync(path.join(annDir, 'pages/Extra.ets'));
  fs.rmSync(path.join(annDir, 'pages/Index.ets'));
  const removedReport = auditProject(baseDir, annDir);
  if (removedReport.ok || !removedReport.findings.some((f) => f.kind === 'removed-file')) {
    throw new Error('removed source file should be rejected');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ANNOTATION_AUDIT_SELFTEST_OK cases=11');
