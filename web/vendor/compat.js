/* Карта сети 3.5.2: недостающие в старых браузерах функции языка (Edge/Chrome 92 2021 года и старше).
 * MapLibre 5 вызывает Object.hasOwn (Chrome 93+) и Array.prototype.at (Chrome 92+) при создании
 * каждого слоя стиля. Без них не создавался ни один слой: схема была пустой, затем — упрощённой.
 * Та же функция выполняется и в фоновых потоках MapLibre (см. vendor/maplibre-gl.js, workerBundleString). */
function __kartaCompat() {
  'use strict';
  var G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this;
  function def(o, k, v) { if (o && !o[k]) try { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); } catch (e) { /* нет */ } }
  def(Object, 'hasOwn', function (o, k) { return Object.prototype.hasOwnProperty.call(Object(o), k); });
  function at(n) {
    n = Math.trunc(n) || 0;
    if (n < 0) n += this.length;
    return n < 0 || n >= this.length ? undefined : this[n];
  }
  function findLast(f, t) { for (var i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return this[i]; return undefined; }
  function findLastIndex(f, t) { for (var i = this.length - 1; i >= 0; i--) if (f.call(t, this[i], i, this)) return i; return -1; }
  var typed = G.Int8Array ? Object.getPrototypeOf(G.Int8Array.prototype) : null;
  [Array.prototype, String.prototype, typed].forEach(function (p) { def(p, 'at', at); });
  [Array.prototype, typed].forEach(function (p) { def(p, 'findLast', findLast); def(p, 'findLastIndex', findLastIndex); });
  def(Array.prototype, 'toSorted', function (f) { return this.slice().sort(f); });
  def(Array.prototype, 'toReversed', function () { return this.slice().reverse(); });
  def(G, 'structuredClone', function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); });
  if (G.AbortSignal) {
    def(G.AbortSignal, 'timeout', function (ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; });
    def(G.AbortSignal.prototype, 'throwIfAborted', function () { if (this.aborted) throw this.reason || new Error('AbortError'); });
  }
}
__kartaCompat();
