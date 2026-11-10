// FYERS Node SDK may deliver Data Socket frames as strings, Buffers, or
// ArrayBuffer views depending on its underlying WebSocket implementation.
// Decode only the transport representation; validation of symbol, LTP and
// exchange timestamp remains in parseTick() and is deliberately unchanged.
export function decodeFyersSocketMessage(raw) {
  let text = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString('utf8');
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString('utf8');
  } else if (ArrayBuffer.isView(raw)) {
    text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  } else if (raw && typeof raw === 'object') {
    return raw;
  } else {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Safe diagnostics only: never emit prices, tokens, or raw market payloads.
export function summarizeFyersSocketMessage(raw, parsed) {
  const rawType = Buffer.isBuffer(raw) ? 'Buffer'
    : raw instanceof ArrayBuffer ? 'ArrayBuffer'
      : ArrayBuffer.isView(raw) ? raw.constructor?.name || 'ArrayBufferView'
        : typeof raw;
  const byteLength = Buffer.isBuffer(raw) ? raw.byteLength
    : raw instanceof ArrayBuffer || ArrayBuffer.isView(raw) ? raw.byteLength
      : typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : null;
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const objects = frames.filter(frame => frame && typeof frame === 'object');
  return {
    rawType,
    byteLength,
    parsedType: Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed,
    frameCount: frames.length,
    topLevelKeys: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).slice(0, 16) : [],
    frameTypes: objects.slice(0, 5).map(frame => typeof frame.type === 'string' ? frame.type.slice(0, 12) : null),
    marketFrameShape: objects.slice(0, 5).map(frame => ({
      type: typeof frame.type === 'string' ? frame.type.slice(0, 12) : null,
      hasSymbol: typeof (frame.symbol || frame.n) === 'string',
      hasLtp: frame.ltp != null || frame.lp != null || frame.v?.lp != null,
      hasExchangeTimestamp: frame.exch_feed_time != null || frame.last_traded_time != null ||
        frame.ltt != null || frame.tt != null || frame.v?.exch_feed_time != null ||
        frame.v?.last_traded_time != null || frame.v?.ltt != null || frame.v?.tt != null
    }))
  };
}
