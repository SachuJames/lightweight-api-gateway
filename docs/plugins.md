# Plugins

The gateway has a small framework-free plugin API. Plugins run inside the
request pipeline (after auth, before rate limiting) and can also observe
responses and errors.

## Writing a plugin

A plugin is an object with a `name` and any of three hooks:

```js
// my-plugin.js
module.exports = {
  name: 'my-plugin',
  version: '1.0.0',

  // May mutate req.headers, or return { statusCode, headers, body }
  // to short-circuit the request (skip rate limit, breaker, proxy).
  async onRequest(req, ctx) {
    if (req.url.startsWith('/internal')) {
      return { statusCode: 403, body: 'nope' };
    }
  },

  // Runs after a proxied response (or a short-circuit).
  async onResponse(res, ctx) {
    res.headers['x-via'] = 'my-gateway';
  },

  // Runs when the pipeline throws for this request.
  async onError(err, ctx) {
    // log, report, etc.
  },
};
```

- `req`: `{ method, url, headers, route, requestId, ip, authUser? }`.
- `ctx.state` is per-request scratch space shared across hooks and plugins;
  `ctx.options` carries this route's options for the plugin (see below).
- A throwing hook never breaks the pipeline: the error is logged and the
  request continues.

The codebase ships an example factory, `createAddHeaderPlugin(header, value)`,
in `apps/gateway/src/plugins.ts`.

## Loading plugins

Set `PLUGIN_DIR` to a directory of `.js` modules; each module's default export
(or `module.exports`) must be a plugin object. At startup the gateway logs
every loaded plugin and every file that failed (with the reason); one broken
file never prevents the others from loading.

## Per-route configuration

A route's `pluginConfig` is a map of plugin name → options object:

```json
{ "pluginConfig": { "add-header": { "x-tenant": "acme" } } }
```

Inside hooks, `ctx.options` holds that route's options for the running plugin.
A route opts out of a plugin by omitting its entry.

## Notes

- Plugins run in registration order for `onRequest`; keep them fast — they sit
  in the hot path before proxying.
- Plugins are server-side code with full access to the request; treat
  `PLUGIN_DIR` like application source: review what you put there.
