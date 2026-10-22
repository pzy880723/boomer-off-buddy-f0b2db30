import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWorkCursor, encodeWorkCursor } from '../src/lib/handheld/work-items.ts';

const ID = '11111111-1111-4111-8111-111111111111';

test('encodeWorkCursor 保留微秒，不做 Date 往返', () => {
  const cursor = encodeWorkCursor('2026-10-22T10:54:05.063706+00:00', ID);
  assert.equal(cursor, '2026-10-22T10:54:05.063706+00:00|' + ID);
  assert.ok(cursor.includes('063706'), 'microseconds must survive');
});

test('encodeWorkCursor 兼容 PG 空格分隔格式，规范化为 T', () => {
  const cursor = encodeWorkCursor('2026-10-22 10:54:05.063706+00', ID);
  assert.equal(cursor, '2026-10-22T10:54:05.063706+00|' + ID);
});

test('decodeWorkCursor 完整往返微秒游标', () => {
  const cursor = encodeWorkCursor('2026-10-22T10:54:05.063706+00:00', ID);
  const parsed = decodeWorkCursor(cursor);
  assert.deepEqual(parsed, { ts: '2026-10-22T10:54:05.063706+00:00', id: ID });
});

test('同毫秒不同微秒的时间戳产生可区分、可排序的游标', () => {
  const a = encodeWorkCursor('2026-10-22T11:00:00.000001+00:00', ID);
  const b = encodeWorkCursor('2026-10-22T11:00:00.000002+00:00', ID);
  assert.notEqual(a, b);
  const pa = decodeWorkCursor(a)!, pb = decodeWorkCursor(b)!;
  assert.ok(Date.parse(pa.ts) === Date.parse(pb.ts), '毫秒相同');
  assert.ok(pa.ts < pb.ts, '微秒序保持');
  // Date 往返会丢微秒（旧 bug 的回归锚点）
  assert.equal(new Date(pa.ts).toISOString(), new Date(pb.ts).toISOString());
});
