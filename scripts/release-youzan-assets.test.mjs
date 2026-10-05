import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

test('candidate is removed before PM2 persistence on both success and rollback paths', () => {
  const source = ts.createSourceFile('release.mjs', readFileSync(new URL('./release-youzan-assets.mjs', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'pm') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const saves = calls.filter(n => n.arguments[0]?.text === 'save');
  assert.equal(saves.length, 1);
  const cleanup = source.statements.find(n => ts.isTryStatement(n) && n.finallyBlock)?.finallyBlock;
  assert.ok(cleanup);
  const deletion = calls.find(n => n.arguments[0]?.text === 'delete' && n.arguments[1]?.text === 'candidate');
  assert.ok(deletion.pos > cleanup.pos && deletion.end < cleanup.end);
  assert.ok(saves[0].pos > deletion.end && saves[0].end < cleanup.end);
});
