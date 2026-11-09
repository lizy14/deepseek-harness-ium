/**
 * Work-edition application egress policy. Install before application dependencies.
 * This is not an OS firewall or a sandbox for malicious plugins: native/custom
 * transports, raw-IP clients without a matching authority, overridden Workers,
 * and external programs such as curl are outside this module's guarantee.
 * No redirect mode, TLS validation, Defender setting or sandbox permission changes.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { domainToASCII, urlToHttpOptions } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

export const BLOCKED_DOMAINS = Object.freeze(['deepseek.com', 'deepseeksvc.com']);
export const BLOCKED_ERROR_CODE = 'ERR_IUM_NETWORK_BLOCKED';

/** Normalize an authority without retaining user information, path or query. */
export function normalizeHostname(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim();
  if (!host) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(host)) {
    try { host = new URL(host).hostname; } catch { return ''; }
  } else if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return '';
    host = host.slice(1, end);
  } else if (/^[^:]+:\d+$/.test(host)) {
    host = host.slice(0, host.lastIndexOf(':'));
  }
  if (net.isIP(host)) return host.toLowerCase();
  // Invalid authority-like input must never make userinfo/path/query appear in
  // audit records. Conservatively inspect its parsed host, not the raw string.
  if (/[@/?#]/.test(host)) {
    try { host = new URL('http://' + host).hostname; } catch { return ''; }
  }
  // WHATWG IDNA handles Unicode/full-width dots. Never fall back to an invalid
  // raw authority: it can contain arbitrary secrets rather than a DNS name.
  const ascii = domainToASCII(host);
  return ascii.toLowerCase().replace(/\.+$/, '');
}

/** Return the blocked normalized hostname, or null; never substring-match. */
export function blockedHost(value) {
  const host = normalizeHostname(value);
  return BLOCKED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) ? host : null;
}

/** Inspect URL/Request input without consuming a Request body. */
export function blockedUrl(value) {
  if (value instanceof URL) return blockedHost(value.hostname);
  if (typeof value === 'string') {
    try { return blockedHost(new URL(value).hostname); } catch { return null; }
  }
  if (value && typeof value.url === 'string') return blockedUrl(value.url);
  return null;
}

function authorityHeader(headers) {
  if (!headers) return null;
  let entries;
  if (Array.isArray(headers)) {
    entries = Array.isArray(headers[0]) ? headers : Array.from({ length: Math.floor(headers.length / 2) }, (_, i) => [headers[i * 2], headers[i * 2 + 1]]);
  } else if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    entries = headers.entries();
  } else if (typeof headers === 'object') {
    entries = Object.entries(headers);
  } else return null;
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || !['host', ':authority'].includes(key.toLowerCase())) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const blocked = blockedHost(item);
      if (blocked) return blocked;
    }
  }
  return null;
}

/** Match Node's URL-then-options merge and hostname-over-host precedence. */
function httpOptions(args) {
  const first = args[0];
  let options;
  if (typeof first === 'string' || first instanceof URL) {
    try { options = urlToHttpOptions(first instanceof URL ? first : new URL(first)); } catch { return null; }
    if (args[1] && typeof args[1] === 'object') options = { ...options, ...args[1] };
  } else if (first && typeof first === 'object') options = first;
  else return null;
  return options;
}
function httpDestination(args) {
  const options = httpOptions(args);
  if (!options) return null;
  return blockedHost(options.hostname || options.host)
    || blockedHost(options.servername)
    || blockedUrl(options.path) // HTTP forward-proxy absolute request target.
    || authorityHeader(options.headers);
}
function fetchDestination(input, init) {
  return blockedUrl(input) || authorityHeader(init?.headers !== undefined ? init.headers : input?.headers);
}

/** Node also passes Socket.connect a normalized [options, callback] array. */
function connectOptions(args) {
  if (Array.isArray(args[0])) return connectOptions(args[0]);
  if (args[0] && typeof args[0] === 'object') return args[0];
  // A nonnumeric string in position zero is an IPC path, not a DNS hostname.
  if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) return { path: args[0] };
  let options = { port: args[0] };
  if (typeof args[1] === 'string') options.host = args[1];
  for (const arg of args.slice(1)) if (arg && typeof arg === 'object' && !Array.isArray(arg)) options = { ...options, ...arg };
  return options;
}
function socketDestination(args) {
  const options = connectOptions(args);
  return typeof options.path === 'string' && options.path.length > 0 ? null : blockedHost(options.host);
}
function tlsDestination(args) {
  const options = connectOptions(args);
  return blockedHost(options.servername) || (typeof options.path === 'string' && options.path.length > 0 ? null : blockedHost(options.host));
}
function electronRequestDestination(args) {
  const input = args[0];
  // Electron supports request({url}) as well as separate host/path fields.
  return blockedUrl(input) || httpDestination(args);
}

/**
 * Explicit process-lifetime owner. Share this owner between both installers.
 * Dispose only in tests or after all network clients have stopped, never while
 * a live application could issue requests. Separate owners must not overlap.
 */
class PolicyOwner {
  #state;
  constructor(audit) {
    this.#state = {
      disposed: false, nodeInstalled: false, electronApps: new WeakSet(),
      restorers: [], audit, dispatcherWrappers: new WeakMap(), guardedDispatchers: new WeakSet(),
    };
    Object.freeze(this);
  }
  static stateOf(owner) {
    if (!(owner instanceof PolicyOwner) || owner.#state.disposed) throw new TypeError('A live createPolicyOwner() result is required');
    return owner.#state;
  }
  dispose() {
    const state = this.#state;
    if (state.disposed) return;
    state.disposed = true;
    const errors = [];
    for (const restore of state.restorers.splice(0).reverse()) {
      try { restore(); } catch (error) { errors.push(error); }
    }
    syncBuiltinESMExports();
    if (errors.length) throw new AggregateError(errors, 'IUM network policy cleanup failed');
  }
}
export function createPolicyOwner({ audit = event => console.error('[ium-network-policy]', JSON.stringify(event)) } = {}) {
  if (typeof audit !== 'function') throw new TypeError('audit must be a function');
  return new PolicyOwner(audit);
}
function stateOf(owner) { return PolicyOwner.stateOf(owner); }
function block(state, mechanism, hostname) {
  // Exactly these two fields: never copy URL, headers, token, body or error data.
  try { state.audit({ mechanism, hostname }); } catch { /* Logging failure cannot authorize a request. */ }
  const error = new Error(`IUM work policy blocked ${hostname} (${mechanism})`);
  error.code = BLOCKED_ERROR_CODE;
  return error;
}
function replaceMethod(state, target, key, factory) {
  const original = target[key];
  if (typeof original !== 'function') throw new TypeError(`Required network method is unavailable: ${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const replacement = factory(original);
  if (!Reflect.set(target, key, replacement) || target[key] !== replacement) throw new TypeError(`Cannot guard network method: ${key}`);
  state.restorers.push(() => {
    if (target[key] !== replacement) return;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  });
  return replacement;
}
function guardSync(state, target, key, mechanism, destination) {
  return replaceMethod(state, target, key, original => function (...args) {
    const hostname = destination(args);
    if (hostname) throw block(state, mechanism, hostname);
    return Reflect.apply(original, this, args);
  });
}
function guardCallbackDns(state, target, key, mechanism) {
  replaceMethod(state, target, key, original => function (hostname, ...rest) {
    const denied = blockedHost(hostname);
    if (!denied) return Reflect.apply(original, this, [hostname, ...rest]);
    const error = block(state, mechanism, denied);
    const callback = rest.at(-1);
    if (typeof callback !== 'function') throw error;
    queueMicrotask(() => callback(error));
    return undefined;
  });
}
function guardPromiseDns(state, target, key, mechanism) {
  replaceMethod(state, target, key, original => async function (hostname, ...rest) {
    const denied = blockedHost(hostname);
    if (denied) throw block(state, mechanism, denied);
    return Reflect.apply(original, this, [hostname, ...rest]);
  });
}

function dispatcherDestination(options) {
  return blockedUrl(options?.origin)
    || blockedUrl(options?.path)
    || (typeof options?.method === 'string' && options.method.toUpperCase() === 'CONNECT' ? blockedHost(options.path) : null)
    || authorityHeader(options?.headers);
}

/** Inspect every Undici dispatch, before a proxy can rewrite origin or reuse a socket. */
class GuardedDispatcher extends Dispatcher {
  #state;
  #delegate;
  constructor(state, delegate) {
    super();
    this.#state = state;
    this.#delegate = delegate;
    // Forward EventEmitter operations without relay listeners/restorer closures
    // that would retain every short-lived custom dispatcher for owner lifetime.
    for (const key of ['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'prependListener', 'prependOnceListener', 'emit', 'listeners', 'rawListeners', 'listenerCount', 'eventNames', 'getMaxListeners', 'setMaxListeners']) {
      if (typeof delegate[key] !== 'function') continue;
      Object.defineProperty(this, key, {
        configurable: true, writable: true,
        value: (...args) => {
          const result = Reflect.apply(delegate[key], delegate, args);
          return result === delegate ? this : result;
        },
      });
    }
  }
  dispatch(options, handler) {
    const hostname = dispatcherDestination(options);
    if (hostname) throw block(this.#state, 'undici.dispatch', hostname);
    return this.#delegate.dispatch(options, handler);
  }
  close(...args) { return Reflect.apply(this.#delegate.close, this.#delegate, args); }
  destroy(...args) { return Reflect.apply(this.#delegate.destroy, this.#delegate, args); }
  get closed() { return this.#delegate.closed; }
  get destroyed() { return this.#delegate.destroyed; }
}
function guardedDispatcher(state, dispatcher) {
  if ((typeof dispatcher !== 'object' && typeof dispatcher !== 'function') || dispatcher === null || typeof dispatcher.dispatch !== 'function') throw new TypeError('fetch dispatcher must provide dispatch()');
  if (state.guardedDispatchers.has(dispatcher)) return dispatcher;
  let guarded = state.dispatcherWrappers.get(dispatcher);
  if (!guarded) {
    guarded = new GuardedDispatcher(state, dispatcher);
    state.dispatcherWrappers.set(dispatcher, guarded);
    state.guardedDispatchers.add(guarded);
  }
  return guarded;
}

// A facade preserves inherited/non-enumerable RequestInit fields and original
// getter receivers, without mutating frozen caller options or their dispatcher.
function withDispatcher(init, dispatcher) {
  if (init === undefined || init === null) return { dispatcher };
  if (typeof init !== 'object' && typeof init !== 'function') throw new TypeError('fetch init must be an object');
  return new Proxy({}, {
    get(_target, key) { return key === 'dispatcher' ? dispatcher : Reflect.get(init, key, init); },
    has(_target, key) { return key === 'dispatcher' || Reflect.has(init, key); },
    ownKeys() { return [...new Set([...Reflect.ownKeys(init), 'dispatcher'])]; },
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'dispatcher') return { configurable: true, enumerable: true, value: dispatcher, writable: false };
      const descriptor = Reflect.getOwnPropertyDescriptor(init, key);
      if (!descriptor) return undefined;
      return { configurable: true, enumerable: descriptor.enumerable, get: () => Reflect.get(init, key, init) };
    },
  });
}

/** Guard Node HTTP and connection/DNS paths before libraries can cache them. */
export function installNodePolicy(owner) {
  const state = stateOf(owner);
  if (state.nodeInstalled) return owner;
  // Preserve the dispatcher selected by Node/proxy bootstrap; do not create an Agent here.
  const previousDispatcher = getGlobalDispatcher();
  const installedDispatcher = guardedDispatcher(state, previousDispatcher);
  setGlobalDispatcher(installedDispatcher);
  state.restorers.push(() => {
    if (getGlobalDispatcher() === installedDispatcher) setGlobalDispatcher(previousDispatcher);
  });
  replaceMethod(state, globalThis, 'fetch', original => function (input, init) {
    try {
      const denied = fetchDestination(input, init);
      if (denied) throw block(state, 'fetch', denied);
      // Explicit per-request dispatchers and a later normal global proxy change
      // are wrapped too. Undici reuses this wrapper for its internal redirects.
      const selected = init?.dispatcher ?? getGlobalDispatcher();
      const dispatcher = guardedDispatcher(state, selected);
      return Reflect.apply(original, this, [input, withDispatcher(init, dispatcher)]);
    } catch (error) { return Promise.reject(error); }
  });
  for (const [module, label] of [[http, 'http'], [https, 'https']]) {
    for (const method of ['request', 'get']) guardSync(state, module, method, `${label}.${method}`, httpDestination);
  }
  guardSync(state, net, 'connect', 'net.connect', socketDestination);
  guardSync(state, net, 'createConnection', 'net.createConnection', socketDestination);
  guardSync(state, net.Socket.prototype, 'connect', 'Socket.connect', socketDestination);
  guardSync(state, tls, 'connect', 'tls.connect', tlsDestination);
  guardCallbackDns(state, dns, 'lookup', 'dns.lookup');
  guardPromiseDns(state, dns.promises, 'lookup', 'dns.promises.lookup');
  const queries = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt'];
  for (const name of queries) {
    if (typeof dns[name] === 'function') guardCallbackDns(state, dns, name, `dns.${name}`);
    if (typeof dns.promises[name] === 'function') guardPromiseDns(state, dns.promises, name, `dns.promises.${name}`);
    if (typeof dns.Resolver.prototype[name] === 'function') guardCallbackDns(state, dns.Resolver.prototype, name, `dns.Resolver.${name}`);
    if (typeof dns.promises.Resolver.prototype[name] === 'function') guardPromiseDns(state, dns.promises.Resolver.prototype, name, `dns.promises.Resolver.${name}`);
  }
  syncBuiltinESMExports();
  state.nodeInstalled = true;
  return owner;
}

const ELECTRON_DENY_PATTERNS = Object.freeze(BLOCKED_DOMAINS.flatMap(domain =>
  ['http', 'https', 'ws', 'wss'].flatMap(scheme => [
    `${scheme}://${domain}/*`, `${scheme}://*.${domain}/*`,
    `${scheme}://${domain}./*`, `${scheme}://*.${domain}./*`,
  ])));

/**
 * Install before any Session/webRequest owners. Chromium has one listener per
 * event: subsequent registrations are composed with this guard, and null only
 * removes the caller's listener. Native Electron behavior needs a native smoke;
 * Node mocks are not a packaged Desktop acceptance result.
 */
export function installElectronPolicy({ app, session, net: electronNet, shell }, owner) {
  const state = stateOf(owner);
  if (state.electronApps.has(app)) return owner;
  const sessions = new WeakSet();
  const protect = browserSession => {
    if (sessions.has(browserSession)) return;
    const webRequest = browserSession.webRequest;
    const originalRegister = webRequest.onBeforeRequest.bind(webRequest);
    let last = { listener: null, filter: null };
    // During disposal restore the last caller's native registration, not a guard.
    state.restorers.push(() => {
      if (last.listener === null) originalRegister(null);
      else if (last.filter) originalRegister(last.filter, last.listener);
      else originalRegister(last.listener);
    });
    const guardedRegister = replaceMethod(state, webRequest, 'onBeforeRequest', () => function (first, second) {
      let listener;
      let filter;
      if (first === null || typeof first === 'function') { listener = first; filter = null; }
      else if (first && typeof first === 'object' && (second === null || typeof second === 'function')) {
        if (!Array.isArray(first.urls)) throw new TypeError('webRequest filter.urls must be an array');
        filter = { ...first, urls: [...first.urls] }; listener = second;
      } else throw new TypeError('Invalid onBeforeRequest registration');
      const hasListener = typeof listener === 'function';
      const merged = !hasListener ? { urls: [...ELECTRON_DENY_PATTERNS] } : filter ? {
        ...filter, urls: [...new Set([...filter.urls, ...ELECTRON_DENY_PATTERNS])],
      } : null;
      const callback = (details, respond) => {
        const denied = blockedUrl(details.url);
        if (denied) { block(state, 'electron.webRequest', denied); respond({ cancel: true }); return; }
        // The extra patterns match only denied hosts, so an allowed URL retains
        // the original filter semantics without implementing Chromium patterns.
        if (hasListener) Reflect.apply(listener, webRequest, [details, respond]);
        else respond({});
      };
      if (merged) originalRegister(merged, callback);
      else originalRegister(callback);
      last = { listener: hasListener ? listener : null, filter };
    });
    guardedRegister(null);
    if (typeof browserSession.fetch === 'function') replaceMethod(state, browserSession, 'fetch', original => function (input, init) {
      const denied = fetchDestination(input, init);
      if (denied) return Promise.reject(block(state, 'electron.session.fetch', denied));
      return Reflect.apply(original, this, [input, init]);
    });
    sessions.add(browserSession);
  };
  const ready = () => protect(session.defaultSession);
  app.on('session-created', protect);
  state.restorers.push(() => app.removeListener('session-created', protect));
  if (app.isReady()) ready();
  else { app.once('ready', ready); state.restorers.push(() => app.removeListener('ready', ready)); }
  const onContents = (_event, contents) => {
    const prevent = (event, url) => {
      const denied = blockedUrl(typeof url === 'string' ? url : event.url);
      if (denied) { block(state, 'electron.navigation', denied); event.preventDefault(); }
    };
    contents.on('will-navigate', prevent);
    contents.on('will-redirect', prevent);
    state.restorers.push(() => { contents.removeListener('will-navigate', prevent); contents.removeListener('will-redirect', prevent); });
    // Programmatic loadURL does not emit will-navigate.
    if (typeof contents.loadURL === 'function') replaceMethod(state, contents, 'loadURL', original => function (url, ...rest) {
      const denied = blockedUrl(url);
      if (denied) return Promise.reject(block(state, 'electron.loadURL', denied));
      return Reflect.apply(original, this, [url, ...rest]);
    });
  };
  app.on('web-contents-created', onContents);
  state.restorers.push(() => app.removeListener('web-contents-created', onContents));
  if (electronNet) {
    guardSync(state, electronNet, 'request', 'electron.net.request', electronRequestDestination);
    if (typeof electronNet.fetch === 'function') replaceMethod(state, electronNet, 'fetch', original => function (input, init) {
      const denied = fetchDestination(input, init);
      if (denied) return Promise.reject(block(state, 'electron.net.fetch', denied));
      return Reflect.apply(original, this, [input, init]);
    });
  }
  if (shell) replaceMethod(state, shell, 'openExternal', original => function (url, ...rest) {
    const denied = blockedUrl(url);
    if (denied) return Promise.reject(block(state, 'electron.openExternal', denied));
    return Reflect.apply(original, this, [url, ...rest]);
  });
  state.electronApps.add(app);
  return owner;
}
