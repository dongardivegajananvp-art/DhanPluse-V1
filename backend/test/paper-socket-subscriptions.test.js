import test from "node:test";
import assert from "node:assert/strict";
import { reconcilePaperSocketSubscriptions } from "../src/paper-socket-subscriptions.js";

function fakeSocket() {
  const calls = [];
  return {
    calls,
    FullMode: 2,
    mode(value) { calls.push(["mode", value]); },
    subscribe(symbols) { calls.push(["subscribe", [...symbols]]); },
    unsubscribe(symbols, isDepth) { calls.push(["unsubscribe", [...symbols], isDepth]); }
  };
}

test("unsubscribes closed paper symbols and subscribes only newly opened symbols", () => {
  const socket = fakeSocket();
  const currentSymbols = new Set(["NSE:ABC26NOV100CE", "NSE:DEF26NOV200PE"]);
  const result = reconcilePaperSocketSubscriptions({
    socket, currentSymbols,
    desiredSymbols: ["NSE:DEF26NOV200PE", "NSE:GHI26NOV300CE"],
    reservedSymbols: ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "BSE:SENSEX-INDEX"]
  });
  assert.deepEqual(result.removed, ["NSE:ABC26NOV100CE"]);
  assert.deepEqual(result.added, ["NSE:GHI26NOV300CE"]);
  assert.deepEqual([...currentSymbols].sort(), ["NSE:DEF26NOV200PE", "NSE:GHI26NOV300CE"]);
  assert.deepEqual(socket.calls, [
    ["unsubscribe", ["NSE:ABC26NOV100CE"], false],
    ["mode", 2],
    ["subscribe", ["NSE:GHI26NOV300CE"]]
  ]);
});

test("does not churn subscriptions when the open-position symbol set is unchanged", () => {
  const socket = fakeSocket();
  const currentSymbols = new Set(["NSE:ABC26NOV100CE"]);
  const result = reconcilePaperSocketSubscriptions({
    socket, currentSymbols, desiredSymbols: ["NSE:ABC26NOV100CE"],
    reservedSymbols: ["NSE:NIFTY50-INDEX"]
  });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(socket.calls, []);
});

test("reapplies only currently open paper symbols after a reconnect", () => {
  const socket = fakeSocket();
  const currentSymbols = new Set(["NSE:ABC26NOV100CE", "NSE:OLD26NOV100PE"]);
  const result = reconcilePaperSocketSubscriptions({
    socket, currentSymbols, desiredSymbols: ["NSE:ABC26NOV100CE"],
    reservedSymbols: ["NSE:NIFTY50-INDEX"], forceSubscribe: true
  });
  assert.deepEqual(result.removed, ["NSE:OLD26NOV100PE"]);
  assert.deepEqual(result.added, ["NSE:ABC26NOV100CE"]);
  assert.deepEqual(socket.calls, [
    ["unsubscribe", ["NSE:OLD26NOV100PE"], false],
    ["mode", 2],
    ["subscribe", ["NSE:ABC26NOV100CE"]]
  ]);
});

test("rejects a known combined socket symbol set above the Standard limit", () => {
  const socket = fakeSocket();
  const currentSymbols = new Set();
  const reservedSymbols = Array.from({ length: 100 }, (_, i) => "NSE:RESERVED" + i + "-EQ");
  assert.throws(() => reconcilePaperSocketSubscriptions({
    socket, currentSymbols, desiredSymbols: ["NSE:NEW26NOV100CE"], reservedSymbols, maxSymbols: 100
  }), /symbol_limit_exceeded/);
  assert.deepEqual(socket.calls, []);
  assert.equal(currentSymbols.size, 0);
});

test("retains tracked symbols if unsubscribe fails so cleanup can be retried", () => {
  const socket = fakeSocket();
  socket.unsubscribe = () => { throw new Error("socket_not_ready"); };
  const currentSymbols = new Set(["NSE:OLD26NOV100PE"]);
  assert.throws(() => reconcilePaperSocketSubscriptions({
    socket, currentSymbols, desiredSymbols: []
  }), /socket_not_ready/);
  assert.deepEqual([...currentSymbols], ["NSE:OLD26NOV100PE"]);
});
