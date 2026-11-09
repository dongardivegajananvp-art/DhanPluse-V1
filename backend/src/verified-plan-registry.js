import crypto from "node:crypto";

/**
 * Process-local registry for server-generated, immutable Sureshot plans.
 * A registry entry is bound to the existing Dashboard Session fingerprint,
 * expires quickly, and can be consumed only after a successful Paper BUY.
 * Restarting the backend intentionally invalidates all outstanding plan IDs.
 */
export function createVerifiedPlanRegistry({ ttlMs = 30_000, now = () => Date.now(), tokenFactory } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000) {
    throw new Error("Verified plan TTL must be between 1 and 60 seconds.");
  }
  const createToken = tokenFactory || (() => crypto.randomBytes(32).toString("base64url"));
  const entries = new Map();

  function prune() {
    const timestamp = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(id);
    }
  }

  function create(sessionBinding, snapshot) {
    const owner = String(sessionBinding || "");
    if (!owner) throw new Error("An authenticated Dashboard Session is required.");
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("A server-generated verified plan snapshot is required.");
    }
    const id = String(createToken() || "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(id) || entries.has(id)) {
      throw new Error("Secure opaque plan ID generation failed.");
    }
    prune();
    const immutableSnapshot = structuredClone(snapshot);
    entries.set(id, {
      owner,
      expiresAt: now() + ttlMs,
      snapshot: immutableSnapshot
    });
    return { planId: id, expiresAt: new Date(now() + ttlMs).toISOString() };
  }

  function get(sessionBinding, planId) {
    prune();
    const id = String(planId || "");
    const entry = entries.get(id);
    if (!entry || entry.owner !== String(sessionBinding || "")) return null;
    return {
      expiresAt: new Date(entry.expiresAt).toISOString(),
      snapshot: structuredClone(entry.snapshot)
    };
  }

  function consume(sessionBinding, planId) {
    const value = get(sessionBinding, planId);
    if (!value) return null;
    entries.delete(String(planId));
    return value.snapshot;
  }

  function clear() { entries.clear(); }
  return { create, get, consume, clear, get size() { prune(); return entries.size; } };
}
