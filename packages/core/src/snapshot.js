import logger from '@percy/logger';
import PercyConfig from '@percy/config';
import micromatch from 'micromatch';

import {
  configSchema
} from './config.js';
import {
  request,
  hostnameMatches,
  createRootResource,
  createPercyCSSResource,
  createLogResource
} from './utils.js';

// Throw a better error message for missing or invalid urls
export function validURL(url, base) {
  if (!url) {
    throw new Error('Missing required URL for snapshot');
  }

  try {
    return new URL(url, base);
  } catch (e) {
    throw new Error(`Invalid snapshot URL: ${e.input}`);
  }
}

// used to deserialize regular expression strings
const RE_REGEXP = /^\/(.+)\/(\w+)?$/;

// Returns true or false if a snapshot matches the provided include and exclude predicates. A
// predicate can be an array of predicates, a regular expression, a glob pattern, or a function.
export function snapshotMatches(snapshot, include, exclude) {
  // support an options object as the second argument
  if (include?.include || include?.exclude) ({ include, exclude } = include);

  // recursive predicate test function
  let test = (predicate, fallback) => {
    if (predicate && typeof predicate === 'string') {
      // snapshot name matches exactly or matches a glob
      let result = snapshot.name === predicate ||
        micromatch.isMatch(snapshot.name, predicate, {
          basename: !predicate.startsWith('/')
        });

      // snapshot might match a string-based regexp pattern
      if (!result) {
        try {
          let [, parsed = predicate, flags] = RE_REGEXP.exec(predicate) || [];
          result = new RegExp(parsed, flags).test(snapshot.name);
        } catch {}
      }

      return result;
    } else if (predicate instanceof RegExp) {
      // snapshot matches a regular expression
      return predicate.test(snapshot.name);
    } else if (typeof predicate === 'function') {
      // advanced matching
      return predicate(snapshot);
    } else if (Array.isArray(predicate) && predicate.length) {
      // array of predicates
      return predicate.some(p => test(p));
    } else {
      // default fallback
      return fallback;
    }
  };

  // nothing to match, return true
  if (!include && !exclude) return true;
  // not excluded or explicitly included
  return !test(exclude, false) && test(include, true);
}

// Accepts an array of snapshots to filter and map with matching options.
export function mapSnapshotOptions(percy, snapshots, config) {
  if (!snapshots?.length) return [];

  // reduce options into a single function
  let applyOptions = [].concat(config?.options || [])
    .reduceRight((next, { include, exclude, ...opts }) => snap => next(
      // assign additional options to included snaphots
      snapshotMatches(snap, include, exclude) ? Object.assign(snap, opts) : snap
    ), s => getSnapshotConfig(percy, s));

  // reduce snapshots with overrides
  return snapshots.reduce((acc, snapshot) => {
    // transform snapshot URL shorthand into an object
    if (typeof snapshot === 'string') snapshot = { url: snapshot };

    // normalize the snapshot url and use it for the default name
    let url = validURL(snapshot.url, config?.baseUrl);
    snapshot.name ||= `${url.pathname}${url.search}${url.hash}`;
    snapshot.url = url.href;

    // use the snapshot when matching include/exclude
    if (snapshotMatches(snapshot, config)) {
      acc.push(applyOptions(snapshot));
    }

    return acc;
  }, []);
}

// Returns an array of derived snapshot options
export async function gatherSnapshots(percy, options) {
  let { baseUrl, snapshots } = options;

  if ('url' in options) snapshots = [options];
  if ('sitemap' in options) snapshots = await getSitemapSnapshots(options);

  // validate evaluated snapshots
  if (typeof snapshots === 'function') {
    ({ snapshots } = validateSnapshotOptions({
      baseUrl, snapshots: await snapshots(baseUrl)
    }));
  }

  // map snapshots with snapshot options
  snapshots = mapSnapshotOptions(percy, snapshots, options);
  if (!snapshots.length) throw new Error('No snapshots found');
  return snapshots;
}

// Validates and migrates snapshot options against the correct schema based on provided
// properties. Eagerly throws an error when missing a URL for any snapshot, and warns about all
// other invalid options which are also scrubbed from the returned migrated options.
export function validateSnapshotOptions(options) {
  let schema;

  // decide which schema to validate against
  if ('domSnapshot' in options) {
    schema = '/snapshot/dom';
  } else if ('url' in options) {
    schema = '/snapshot';
  } else if ('sitemap' in options) {
    schema = '/snapshot/sitemap';
  } else if ('serve' in options) {
    schema = '/snapshot/server';
  } else if ('snapshots' in options) {
    schema = '/snapshot/list';
  } else {
    schema = '/snapshot';
  }

  let {
    // migrate and remove certain properties from validating
    clientInfo, environmentInfo, snapshots, ...migrated
  } = PercyConfig.migrate(options, schema);

  // gather info for validating individual snapshot URLs
  let isSnapshot = schema === '/snapshot/dom' || schema === '/snapshot';
  let baseUrl = schema === '/snapshot/server' ? 'http://localhost' : options.baseUrl;
  let snaps = isSnapshot ? [migrated] : Array.isArray(snapshots) ? snapshots : [];
  for (let snap of snaps) validURL(typeof snap === 'string' ? snap : snap.url, baseUrl);

  // add back snapshots before validating and scrubbing; function snapshots are validated later
  if (snapshots) migrated.snapshots = typeof snapshots === 'function' ? [] : snapshots;
  else if (!isSnapshot && options.snapshots) migrated.snapshots = [];
  let errors = PercyConfig.validate(migrated, schema);

  if (errors) {
    // warn on validation errors
    let log = logger('core:snapshot');
    log.warn('Invalid snapshot options:');
    for (let e of errors) log.warn(`- ${e.path}: ${e.message}`);
  }

  // add back the snapshots function if there was one
  if (typeof snapshots === 'function') migrated.snapshots = snapshots;
  // add back an empty array if all server snapshots were scrubbed
  if ('serve' in options && 'snapshots' in options) migrated.snapshots ??= [];

  return { clientInfo, environmentInfo, ...migrated };
}

// Fetches a sitemap and parses it into a list of URLs for taking snapshots. Duplicate URLs,
// including a trailing slash, are removed from the resulting list.
export async function getSitemapSnapshots(options) {
  return request(options.sitemap, (body, res) => {
    // validate sitemap content-type
    let [contentType] = res.headers['content-type'].split(';');

    if (!/^(application|text)\/xml$/.test(contentType)) {
      throw new Error('The sitemap must be an XML document, ' + (
        `but the content-type was "${contentType}"`));
    }

    // parse XML content into a list of URLs
    let urls = body.match(/(?<=<loc>)(.*)(?=<\/loc>)/ig) ?? [];

    // filter out duplicate URLs that differ by a trailing slash
    return urls.filter((url, i) => {
      let match = urls.indexOf(url.replace(/\/$/, ''));
      return match === -1 || match === i;
    });
  });
}

// Return snapshot options merged with defaults and global options.
export function getSnapshotConfig(percy, options) {
  return PercyConfig.merge([{
    widths: configSchema.snapshot.properties.widths.default,
    discovery: { allowedHostnames: [validURL(options.url).hostname] },
    meta: { snapshot: { name: options.name }, build: percy.build }
  }, percy.config.snapshot, {
    // only specific discovery options are used per-snapshot
    discovery: {
      allowedHostnames: percy.config.discovery.allowedHostnames,
      disallowedHostnames: percy.config.discovery.disallowedHostnames,
      networkIdleTimeout: percy.config.discovery.networkIdleTimeout,
      requestHeaders: percy.config.discovery.requestHeaders,
      authorization: percy.config.discovery.authorization,
      disableCache: percy.config.discovery.disableCache,
      userAgent: percy.config.discovery.userAgent
    }
  }, options], (path, prev, next) => {
    switch (path.map(k => k.toString()).join('.')) {
      case 'widths': // dedup, sort, and override widths when not empty
        return [path, next?.length ? Array.from(new Set(next)).sort((a, b) => a - b) : prev];
      case 'percyCSS': // concatenate percy css
        return [path, [prev, next].filter(Boolean).join('\n')];
      case 'execute': // shorthand for execute.beforeSnapshot
        return (Array.isArray(next) || typeof next !== 'object')
          ? [path.concat('beforeSnapshot'), next] : [path];
      case 'discovery.disallowedHostnames': // prevent disallowing the root hostname
        return [path, (prev ?? []).concat(next).filter(h => !hostnameMatches(h, options.url))];
    }

    // ensure additional snapshots have complete names
    if (path[0] === 'additionalSnapshots' && path.length === 2) {
      let { prefix = '', suffix = '', ...n } = next;
      next = { name: `${prefix}${options.name}${suffix}`, ...n };
      return [path, next];
    }
  });
}

// Returns a complete and valid snapshot config object and logs verbose debug logs detailing various
// snapshot options. When `showInfo` is true, specific messages will be logged as info logs rather
// than debug logs.
function debugSnapshotConfig(snapshot, showInfo) {
  let log = logger('core:snapshot');

  // log snapshot info
  log.debug('---------', snapshot.meta);
  if (showInfo) log.info(`Snapshot found: ${snapshot.name}`, snapshot.meta);
  else log.debug(`Handling snapshot: ${snapshot.name}`, snapshot.meta);

  // will log debug info for an object property if its value is defined
  let debugProp = (obj, prop, format = String) => {
    let val = prop.split('.').reduce((o, k) => o?.[k], obj);

    if (val != null) {
      // join formatted array values with a space
      val = [].concat(val).map(format).join(', ');
      log.debug(`- ${prop}: ${val}`, snapshot.meta);
    }
  };

  debugProp(snapshot, 'url');
  debugProp(snapshot, 'widths', v => `${v}px`);
  debugProp(snapshot, 'minHeight', v => `${v}px`);
  debugProp(snapshot, 'enableJavaScript');
  debugProp(snapshot, 'waitForTimeout');
  debugProp(snapshot, 'waitForSelector');
  debugProp(snapshot, 'execute.afterNavigation');
  debugProp(snapshot, 'execute.beforeResize');
  debugProp(snapshot, 'execute.afterResize');
  debugProp(snapshot, 'execute.beforeSnapshot');
  debugProp(snapshot, 'discovery.allowedHostnames');
  debugProp(snapshot, 'discovery.disallowedHostnames');
  debugProp(snapshot, 'discovery.requestHeaders', JSON.stringify);
  debugProp(snapshot, 'discovery.authorization', JSON.stringify);
  debugProp(snapshot, 'discovery.disableCache');
  debugProp(snapshot, 'discovery.userAgent');
  debugProp(snapshot, 'clientInfo');
  debugProp(snapshot, 'environmentInfo');
  debugProp(snapshot, 'domSnapshot', Boolean);

  for (let added of (snapshot.additionalSnapshots || [])) {
    if (showInfo) log.info(`Snapshot found: ${added.name}`, snapshot.meta);
    else log.debug(`Additional snapshot: ${added.name}`, snapshot.meta);

    debugProp(added, 'waitForTimeout');
    debugProp(added, 'waitForSelector');
    debugProp(added, 'execute');
  }
}

// Calls the provided callback with additional resources
function handleSnapshotResources(snapshot, map, callback) {
  let resources = [...map.values()];

  // sort the root resource first
  let [root] = resources.splice(resources.findIndex(r => r.root), 1);
  resources.unshift(root);

  // inject Percy CSS
  if (snapshot.percyCSS) {
    let css = createPercyCSSResource(root.url, snapshot.percyCSS);
    resources.push(css);

    // replace root contents and associated properties
    Object.assign(root, createRootResource(root.url, (
      root.content.replace(/(<\/body>)(?!.*\1)/is, (
        `<link data-percy-specific-css rel="stylesheet" href="${css.pathname}"/>`
      ) + '$&'))));
  }

  // include associated snapshot logs matched by meta information
  resources.push(createLogResource(logger.query(log => (
    log.meta.snapshot?.name === snapshot.meta.snapshot.name
  ))));

  return callback(snapshot, resources);
}

// Wait for a page's asset discovery network to idle
function waitForDiscoveryNetworkIdle(page, options) {
  let { allowedHostnames, networkIdleTimeout } = options;
  let filter = r => hostnameMatches(allowedHostnames, r.url);

  return page.network.idle(filter, networkIdleTimeout);
}

// Used to cache resources across core instances
const RESOURCE_CACHE_KEY = Symbol('resource-cache');

// Discovers resources for a snapshot using a browser page to intercept requests. The callback
// function will be called with the snapshot name (for additional snapshots) and an array of
// discovered resources. When additional snapshots are provided, the callback will be called once
// for each snapshot.
export async function* discoverSnapshotResources(percy, snapshot, callback) {
  debugSnapshotConfig(snapshot, percy.dryRun);

  // when dry-running, invoke the callback for each snapshot and immediately return
  let allSnapshots = [snapshot, ...(snapshot.additionalSnapshots || [])];
  if (percy.dryRun) return allSnapshots.map(s => callback(s));

  // keep a global resource cache across snapshots
  let cache = percy[RESOURCE_CACHE_KEY] ||= new Map();
  // copy widths to prevent mutation later
  let widths = snapshot.widths.slice();

  // preload the root resource for existing dom snapshots
  let resources = new Map(snapshot.domSnapshot && (
    [createRootResource(snapshot.url, snapshot.domSnapshot)]
      .map(resource => [resource.url, resource])
  ));

  // open a new browser page
  let page = yield percy.browser.page({
    enableJavaScript: snapshot.enableJavaScript ?? !snapshot.domSnapshot,
    networkIdleTimeout: snapshot.discovery.networkIdleTimeout,
    requestHeaders: snapshot.discovery.requestHeaders,
    authorization: snapshot.discovery.authorization,
    userAgent: snapshot.discovery.userAgent,
    meta: snapshot.meta,

    // enable network inteception
    intercept: {
      enableJavaScript: snapshot.enableJavaScript,
      disableCache: snapshot.discovery.disableCache,
      allowedHostnames: snapshot.discovery.allowedHostnames,
      disallowedHostnames: snapshot.discovery.disallowedHostnames,
      getResource: u => resources.get(u) || cache.get(u),
      saveResource: r => resources.set(r.url, r) && cache.set(r.url, r)
    }
  });

  try {
    // set the initial page size
    yield page.resize({
      width: widths.shift(),
      height: snapshot.minHeight
    });

    // navigate to the url
    yield page.goto(snapshot.url);
    yield page.evaluate(snapshot.execute?.afterNavigation);

    // trigger resize events for other widths
    for (let width of widths) {
      yield page.evaluate(snapshot.execute?.beforeResize);
      yield waitForDiscoveryNetworkIdle(page, snapshot.discovery);
      yield page.resize({ width, height: snapshot.minHeight });
      yield page.evaluate(snapshot.execute?.afterResize);
    }

    if (snapshot.domSnapshot) {
      // ensure discovery has finished and handle resources
      yield waitForDiscoveryNetworkIdle(page, snapshot.discovery);
      handleSnapshotResources(snapshot, resources, callback);
    } else {
      let { enableJavaScript } = snapshot;

      // capture snapshots sequentially
      for (let snap of allSnapshots) {
        // will wait for timeouts, selectors, and additional network activity
        let { url, dom } = yield page.snapshot({ enableJavaScript, ...snap });
        let root = createRootResource(url, dom);
        // use the normalized root url to prevent duplicates
        resources.set(root.url, root);
        // shallow merge with root snapshot options
        handleSnapshotResources({ ...snapshot, ...snap }, resources, callback);
        // remove the previously captured dom snapshot
        resources.delete(root.url);
      }
    }

    // page clean up
    await page.close();
  } catch (error) {
    await page.close();
    throw error;
  }
}
