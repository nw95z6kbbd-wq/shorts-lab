(function () {
  'use strict';
  // Provider boundary for future backend adapters. Never put API keys in browser code.
  class IntegrationRegistry {
    constructor() { this.providers = new Map(); }

    register(name, provider) {
      if (typeof name !== 'string' || !name || typeof provider?.run !== 'function') {
        throw new TypeError('Провайдер должен иметь имя и метод run(payload, { signal }).');
      }
      this.providers.set(name, provider);
    }

    isAvailable(name) { return this.providers.has(name); }

    async run(name, payload, options = {}) {
      const provider = this.providers.get(name);
      if (!provider) throw new Error('Интеграция пока не подключена: ' + name);
      options.signal?.throwIfAborted();
      return provider.run(payload, options);
    }
  }

  window.ShortsIntegrations = new IntegrationRegistry();
  // Future contracts: voice.run({ scenes, voiceId }, { signal }) -> { audio: Blob, sceneDurationsMs: [] }
  //                   video.run({ scenes, style, audio }, { signal }) -> { video: Blob }
  // Register adapters only after a backend is configured. The offline editor does not depend on them.
})();
