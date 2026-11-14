/**
 * Prune expired entries and enforce a hard upper bound on a runtime Map.
 * Entries must carry a numeric timestamp in timestampField. Oldest entries
 * are evicted first when the map exceeds maxEntries.
 */
export function pruneExpiredMap(map, {
  now = Date.now(),
  ttlMs = Infinity,
  maxEntries = Infinity,
  timestampField = "createdAt"
} = {}) {
  if (!(map instanceof Map)) throw new TypeError("map must be a Map");
  if (!Number.isFinite(Number(now))) throw new TypeError("now must be finite");
  if (!(ttlMs === Infinity || (Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 0))) {
    throw new TypeError("ttlMs must be non-negative or Infinity");
  }
  if (!(maxEntries === Infinity || (Number.isInteger(maxEntries) && maxEntries >= 0))) {
    throw new TypeError("maxEntries must be a non-negative integer or Infinity");
  }

  let removed = 0;
  const timestampOf = value => Number(value?.[timestampField]);
  for (const [key, value] of map) {
    const timestamp = timestampOf(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || Number(now) - timestamp > ttlMs) {
      map.delete(key);
      removed += 1;
    }
  }

  while (map.size > maxEntries) {
    let oldestKey;
    let oldestTimestamp = Infinity;
    for (const [key, value] of map) {
      const timestamp = timestampOf(value);
      if (timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
    removed += 1;
  }
  return { removed, remaining: map.size };
}
