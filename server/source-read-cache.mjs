// Share one source scan while it is in flight. Invalidations fence late results;
// they do not cancel readers that already hold the old snapshot.
export function createSourceReadCache(read, { ttlMs = 4000, now = Date.now } = {}) {
  let generation = 0, cached = null, flight = null;
  const drop = () => { generation++; cached = null; };
  function get({ force = false } = {}) {
    if (force) drop();
    const age = cached ? now() - cached.at : Infinity;
    if (cached && cached.generation === generation && age >= 0 && age < ttlMs) return Promise.resolve(cached.value);
    if (flight?.generation === generation) return flight.promise;
    const entry = { generation, promise: null };
    entry.promise = Promise.resolve().then(read).then(value => {
      if (entry.generation === generation) cached = { generation, at: now(), value };
      return value;
    }).finally(() => { if (flight === entry) flight = null; });
    flight = entry;
    return entry.promise;
  }
  return { get, drop, generation: () => generation };
}
