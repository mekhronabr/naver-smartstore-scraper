export class ProxyManager {
  constructor(proxies = []) {
    this.proxies = proxies.map((p) => ({ ...p, cooldownUntil: 0, fails: 0 }));
    this.i = 0;
  }

  next() {
    const now = Date.now();
    for (let k = 0; k < this.proxies.length; k++) {
      const idx = (this.i + k) % this.proxies.length;
      const p = this.proxies[idx];
      if (p.cooldownUntil <= now) {
        this.i = (idx + 1) % this.proxies.length;
        return p;
      }
    }
    return null;
  }

  markFail(proxy, cooldownMs = 60_000) {
    if (!proxy) return;
    proxy.fails++;
    proxy.cooldownUntil = Date.now() + cooldownMs;
  }

  markOk(proxy) {
    if (!proxy) return;
    proxy.fails = Math.max(0, proxy.fails - 1);
  }
}