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
test('release scripts require an explicit current release instead of a stale rollback path', () => {
  const deploy = readFileSync(new URL('./release-youzan-assets.mjs', import.meta.url), 'utf8');
  const prepare = readFileSync(new URL('./prepare-youzan-assets-candidate.sh', import.meta.url), 'utf8');
  assert.match(deploy, /previous = process\.env\.ASSET_PREVIOUS_DIR/);
  assert.match(prepare, /ASSET_PREVIOUS_DIR:\?/);
  assert.doesNotMatch(deploy + prepare, /listing-summary-90d6633/);
});
test('candidate overlay must reject environment files and keep production credentials outside the archive', () => {
  const prepare = readFileSync(new URL('./prepare-youzan-assets-candidate.sh', import.meta.url), 'utf8');
  assert.match(prepare, /release_archive_contains_environment/);
  assert.ok(prepare.indexOf('release_archive_contains_environment') < prepare.indexOf('tar -C "$release" -xf'));
});
