import { getReferenceDataRetryDelay } from './reference-data-backoff.js';

const NSE_FO_MASTER_URL = 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json';
const NSE_CM_MASTER_URL = 'https://public.fyers.in/sym_details/NSE_CM_sym_master.json';

// Both NSE movers and Sureshot consume the same official reference-data load.
// Cache only the compact, validated snapshot returned by build(); never retain
// the two very large raw JSON masters in process memory.
export function createNseSymbolMasterLoader({
  fetchImpl = globalThis.fetch,
  build,
  cacheMs = 24 * 60 * 60 * 1000,
  timeoutMs = 120_000,
  now = Date.now,
  loadPersistedSnapshot = async () => null,
  savePersistedSnapshot = async () => {},
  onDiagnostic = () => {}
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof build !== 'function') throw new TypeError('build must be a function');

  let cachedSnapshot = null;
  let cachedAt = 0;
  let inFlight = null;
  let failureCount = 0;
  let retryAt = 0;
  let lastFailureMessage = '';

  function report(event, detail) {
    try { onDiagnostic(event, detail); } catch {}
  }

  async function load() {
    if (cachedSnapshot && now() - cachedAt < cacheMs) return cachedSnapshot;
    if (inFlight) return inFlight;
    if (now() < retryAt) {
      const error = new Error(lastFailureMessage || 'FYERS NSE symbol master retry is cooling down.');
      error.statusCode = 503;
      error.retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now()) / 1000));
      throw error;
    }

    inFlight = (async () => {
      const startedAt = now();
      // A validated symbol snapshot is reference metadata, not market data. A
      // bounded-age PostgreSQL copy survives Render restarts and avoids pulling
      // the large public masters on every cold start.
      try {
        const persisted = await loadPersistedSnapshot({ maxAgeMs: cacheMs });
        if (persisted && typeof persisted === 'object' && !Array.isArray(persisted.snapshot)) {
          cachedSnapshot = persisted.snapshot;
          cachedAt = now();
          report('persisted_cache_hit', {
            ageMs: Math.max(0, Number(persisted.ageMs) || 0),
            universeCount: Array.isArray(cachedSnapshot.universe) ? cachedSnapshot.universe.length : null,
            moversCount: Array.isArray(cachedSnapshot.moversSymbols) ? cachedSnapshot.moversSymbols.length : null
          });
          return cachedSnapshot;
        }
      } catch (error) {
        report('persisted_cache_read_failed', { message: String(error?.message || error).slice(0, 160) });
      }
      let stage = 'FETCH_NSE_SYMBOL_MASTERS';
      let foResponse;
      let cmResponse;
      try {
        // Fetch both files together to bound network wait, then parse them
        // sequentially so two large JSON.parse operations never overlap.
        [foResponse, cmResponse] = await Promise.all([
          fetchImpl(NSE_FO_MASTER_URL, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: 'application/json' }
          }),
          fetchImpl(NSE_CM_MASTER_URL, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: 'application/json' }
          })
        ]);

        stage = 'VALIDATE_NSE_FO_RESPONSE';
        if (!foResponse?.ok) {
          const error = new Error(`FYERS NSE_FO symbol master HTTP ${foResponse?.status ?? 'unavailable'}.`);
          error.statusCode = foResponse?.status || 503;
          throw error;
        }
        stage = 'VALIDATE_NSE_CM_RESPONSE';
        if (!cmResponse?.ok) {
          const error = new Error(`FYERS NSE_CM symbol master HTTP ${cmResponse?.status ?? 'unavailable'}.`);
          error.statusCode = cmResponse?.status || 503;
          throw error;
        }

        stage = 'PARSE_NSE_FO_MASTER';
        const foMaster = await foResponse.json();
        if (!foMaster || typeof foMaster !== 'object' || Array.isArray(foMaster)) {
          throw new Error('FYERS NSE_FO symbol master format is invalid.');
        }

        stage = 'PARSE_NSE_CM_MASTER';
        const cmMaster = await cmResponse.json();
        if (!cmMaster || typeof cmMaster !== 'object' || Array.isArray(cmMaster)) {
          throw new Error('FYERS NSE_CM symbol master format is invalid.');
        }

        stage = 'BUILD_VALIDATED_NSE_SNAPSHOT';
        const snapshot = build(foMaster, cmMaster);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          throw new Error('FYERS NSE symbol master builder returned an invalid snapshot.');
        }

        cachedSnapshot = snapshot;
        cachedAt = now();
        try {
          await savePersistedSnapshot(snapshot, { fetchedAt: new Date(cachedAt).toISOString() });
          report('persisted_cache_saved', { universeCount: Array.isArray(snapshot.universe) ? snapshot.universe.length : null });
        } catch (error) {
          report('persisted_cache_save_failed', { message: String(error?.message || error).slice(0, 160) });
        }
        failureCount = 0;
        retryAt = 0;
        lastFailureMessage = '';
        report('loaded', {
          stage,
          elapsedMs: Math.max(0, now() - startedAt),
          foHttpStatus: foResponse.status,
          cmHttpStatus: cmResponse.status,
          foEntries: Object.keys(foMaster).length,
          cmEntries: Object.keys(cmMaster).length,
          universeCount: Array.isArray(snapshot.universe) ? snapshot.universe.length : null,
          moversCount: Array.isArray(snapshot.moversSymbols) ? snapshot.moversSymbols.length : null
        });
        return cachedSnapshot;
      } catch (error) {
        failureCount += 1;
        const retryDelayMs = getReferenceDataRetryDelay(failureCount);
        retryAt = now() + retryDelayMs;
        lastFailureMessage = String(error?.message || 'FYERS NSE symbol master unavailable').slice(0, 180);
        error.retryAfterSeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
        report('failed', {
          stage,
          elapsedMs: Math.max(0, now() - startedAt),
          httpStatus: Number.isInteger(error?.statusCode) ? error.statusCode : null,
          retryAfterSeconds: error.retryAfterSeconds,
          errorName: String(error?.name || 'Error').slice(0, 60),
          errorCode: String(error?.cause?.code || error?.code || '').slice(0, 60) || null,
          message: String(error?.message || 'NSE symbol master unavailable').slice(0, 180)
        });
        throw error;
      }
    })().finally(() => { inFlight = null; });

    return inFlight;
  }

  return load;
}
