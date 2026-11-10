'use strict';

const path = require('path');
const fs = require('fs');
const { scanText, ruleProposal, applyProposalToText } = require('./cli');

const fixture = path.join(__dirname, 'fixtures/sample.ets');
const text = fs.readFileSync(fixture, 'utf8');
const candidates = scanText(fixture, text);
const names = new Set(candidates.map((candidate) => candidate.component));
for (const expected of ['Button', 'TextInput', 'Slider', 'Image', 'Text']) {
  if (!names.has(expected)) throw new Error(`scan missed ${expected}`);
}
const button = candidates.find((candidate) => candidate.component === 'Button');
if (!button) throw new Error('Button candidate missing');
const proposal = ruleProposal(button, 0);
const applied = applyProposalToText(text, button, proposal, '../semantics/Sem');
if (!applied.changed) throw new Error(`apply failed: ${applied.reason}`);
if (!applied.text.includes(".customProperty('sem', Sem.node(")) throw new Error('customProperty missing');
if (!applied.text.includes("import { Sem } from '../semantics/Sem';")) throw new Error('Sem import missing');
console.log(`ANNOTATOR_SELFTEST_OK candidates=${candidates.length} components=${[...names].join(',')}`);
