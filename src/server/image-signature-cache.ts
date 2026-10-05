export function createImageSignatureCache(ttl = 3600000, capacity = 1000, now = Date.now) {
  const entries = new Map<string, {expires: number; promise: Promise<string|null>}>();
  return {get(key: string, load: ()=>Promise<string|null>): Promise<string|null> {
    const existing = entries.get(key);
    if (existing && existing.expires > now()) return existing.promise;
    entries.delete(key);
    const entry = {expires: now()+ttl, promise: Promise.resolve().then(load)};
    entry.promise = entry.promise.then(value=>{
      if (!value && entries.get(key) === entry) entries.delete(key);
      return value;
    },error=>{
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key,entry);
    while(entries.size > capacity) entries.delete(entries.keys().next().value!);
    return entry.promise;
  }};
}
