export function reconcilePaperSocketSubscriptions({
  socket,
  currentSymbols,
  desiredSymbols,
  reservedSymbols = [],
  maxSymbols = 100,
  forceSubscribe = false
}) {
  if (!socket || !(currentSymbols instanceof Set) || !Array.isArray(desiredSymbols) ||
      !Array.isArray(reservedSymbols) || !Number.isInteger(maxSymbols) || maxSymbols < 1) {
    throw new Error("invalid_paper_socket_subscription_state");
  }
  const desired = new Set(desiredSymbols.map(String).filter(Boolean));
  const reserved = new Set(reservedSymbols.map(String).filter(Boolean));
  const removed = [...currentSymbols].filter(symbol => !desired.has(symbol));
  if (removed.length) {
    if (typeof socket.unsubscribe !== "function") {
      throw new Error("fyers_socket_unsubscribe_unavailable");
    }
    socket.unsubscribe(removed, false);
    for (const symbol of removed) currentSymbols.delete(symbol);
  }

  const totalKnownSymbols = new Set([...reserved, ...desired]).size;
  if (totalKnownSymbols > maxSymbols) {
    throw new Error("fyers_standard_socket_symbol_limit_exceeded");
  }

  const added = forceSubscribe
    ? [...desired]
    : [...desired].filter(symbol => !currentSymbols.has(symbol));
  if (added.length) {
    if (typeof socket.mode === "function") socket.mode(socket.FullMode);
    if (typeof socket.subscribe !== "function") {
      throw new Error("fyers_socket_subscribe_unavailable");
    }
    socket.subscribe(added);
    for (const symbol of added) currentSymbols.add(symbol);
  }
  return { added, removed, totalKnownSymbols, activePaperSymbols: [...currentSymbols] };
}
