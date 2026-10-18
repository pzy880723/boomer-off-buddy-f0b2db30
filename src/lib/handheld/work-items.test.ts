import test from 'node:test';import assert from 'node:assert/strict';
import {decodeWorkCursor,workItemsInput,parseWorkCounts} from './work-items';
test('default 50 and bounded page size',()=>{assert.equal(workItemsInput.parse({}).limit,50);assert.equal(workItemsInput.safeParse({limit:101}).success,false);assert.equal(workItemsInput.safeParse({limit:0}).success,false);});
test('untrusted roles scope and invalid store rejected',()=>{assert.equal(workItemsInput.safeParse({role:'super_admin'}).success,false);assert.equal(workItemsInput.safeParse({location_id:'A'}).success,false);});
test('cursor requires valid time and stable uuid',()=>{assert.throws(()=>decodeWorkCursor('bad|id'));assert.deepEqual(decodeWorkCursor('2026-10-18T00:00:00Z|11111111-1111-4111-8111-111111111111'),{ts:'2026-10-18T00:00:00Z',id:'11111111-1111-4111-8111-111111111111'});});
test('pending counts failure never silently becomes empty',()=>{assert.throws(()=>parseWorkCounts({customers:1,internal:0,orders:0,system:0,total:0}));assert.equal(parseWorkCounts({customers:1,internal:2,orders:3,system:4,total:10}).total,10);});
