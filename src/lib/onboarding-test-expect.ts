import assert from 'node:assert/strict';
// Node's test runner and assertions are already used by this project; no test dependency added.
export function expect(value:unknown){
 const invoke=()=>{if(typeof value!=='function')throw Error('function_expected');(value as ()=>unknown)();};
 return {toBe:(other:unknown)=>assert.equal(value,other),toEqual:(other:unknown)=>assert.deepEqual(value,other),
 toThrow:(message?:string)=>{if(message)assert.throws(invoke,new RegExp(message));else assert.throws(invoke);},
 not:{toThrow:()=>assert.doesNotThrow(invoke)}};
}