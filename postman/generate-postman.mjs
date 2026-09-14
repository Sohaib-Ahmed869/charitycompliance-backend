/**
 * generate-postman.mjs — build a complete Postman collection by
 * introspecting the Express routes.
 *
 * Run from anywhere:  node postman/generate-postman.mjs
 *
 * It reads src/app.js (route mounts) + every src/routes/**.js file,
 * extracts every router.get/post/put/patch/delete(...) definition, and
 * emits two importable files into this folder:
 *
 *   Stewardex.postman_collection.json   — all endpoints, foldered by
 *                                         module, with bearer auth,
 *                                         x-org-id header, JSON body
 *                                         skeletons + a status test.
 *   Stewardex.postman_environment.json  — base_url / token / org_id …
 *
 * Re-run it whenever routes change to keep the collection in sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');
const APP_JS = path.join(BACKEND, 'src', 'app.js');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// ── 1. Parse app.js — map route-file imports to their mount paths ────
const appSrc = fs.readFileSync(APP_JS, 'utf8');

// import xxxRoutes from './routes/.../yyy.js'
const varToFile = {};
for (const mt of appSrc.matchAll(/import\s+(\w+)\s+from\s+['"](\.\/routes\/[^'"]+)['"]/g)) {
  varToFile[mt[1]] = mt[2];
}

// app.use('/api/v1/...', <something with a routes var>)  — line by line so
// the express.raw(...) wrapper on the webhook mount doesn't trip us up.
const mounts = []; // { mountPath, file }
for (const line of appSrc.split('\n')) {
  const pathMatch = line.match(/app\.use\(\s*['"](\/api\/v1\/[^'"]+)['"]/);
  if (!pathMatch) continue;
  const mountPath = pathMatch[1];
  const varName = Object.keys(varToFile).find((v) => new RegExp(`\\b${v}\\b`).test(line));
  if (varName) mounts.push({ mountPath, file: varToFile[varName] });
}

// ── 2. Extract endpoints from each route file ───────────────────────
function titleCase(s) {
  return s.replace(/Routes?$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function joinPath(base, sub) {
  const a = base.replace(/\/+$/, '');
  const b = (sub || '/').replace(/^\/?/, '/');
  return (a + (b === '/' ? '' : b)) || '/';
}

/** Pull express-validator body('x') field names out of a code slice. */
function bodyFields(slice) {
  const set = new Set();
  for (const mt of slice.matchAll(/\bbody\(\s*['"]([^'".\][]+)['"]/g)) set.add(mt[1]);
  return [...set];
}

const modules = []; // { name, mountPath, file, endpoints: [{method, fullPath, sub, bodyFields}] }

for (const { mountPath, file } of mounts) {
  const abs = path.join(BACKEND, 'src', file.replace(/^\.\//, ''));
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');

  const routeRe = new RegExp(
    `router\\.(${HTTP_METHODS.join('|')})\\s*\\(\\s*[\`'"]([^\`'"]*)[\`'"]`,
    'g'
  );
  const matches = [...src.matchAll(routeRe)];
  const endpoints = [];
  matches.forEach((mt, i) => {
    const method = mt[1].toUpperCase();
    const sub = mt[2];
    // Slice from this route to the next one to find its own validators.
    const start = mt.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : src.length;
    endpoints.push({
      method,
      sub,
      fullPath: joinPath(mountPath, sub),
      bodyFields: ['POST', 'PUT', 'PATCH'].includes(method)
        ? bodyFields(src.slice(start, end))
        : []
    });
  });
  if (endpoints.length) {
    modules.push({
      name: titleCase(path.basename(file, '.js')),
      mountPath,
      file: file.replace(/^\.\//, 'src/'),
      endpoints
    });
  }
}

// ── 3. Group modules into top-level folders ─────────────────────────
function categoryOf(mountPath) {
  if (mountPath.startsWith('/api/v1/auth')) return 'Auth';
  if (mountPath.startsWith('/api/v1/public')) return 'Public';
  if (mountPath.startsWith('/api/v1/admin')) return 'Admin (Calcite SuperAdmin)';
  if (mountPath.startsWith('/api/v1/webhooks')) return 'Webhooks';
  return 'Platform (tenant)';
}

// ── 4. Build Postman v2.1 items ─────────────────────────────────────
function urlObject(fullPath) {
  const segs = fullPath.split('/').filter(Boolean);
  const variable = segs
    .filter((s) => s.startsWith(':'))
    .map((s) => ({ key: s.slice(1), value: '', description: 'Path parameter' }));
  return {
    raw: `{{base_url}}${fullPath}`,
    host: ['{{base_url}}'],
    path: segs,
    ...(variable.length ? { variable } : {})
  };
}

const STATUS_TEST = [
  "pm.test('No server error (status < 500)', function () {",
  '  pm.expect(pm.response.code).to.be.below(500);',
  '});'
];

// The Auth login response carries the JWT — capture it into the env so
// every other request is authenticated automatically.
const LOGIN_CAPTURE = [
  'try {',
  '  const j = pm.response.json();',
  '  const d = j && (j.data || j);',
  '  const token = d && (d.token || d.accessToken || d.access_token);',
  '  if (token) {',
  "    pm.environment.set('token', token);",
  "    pm.collectionVariables.set('token', token);",
  '  }',
  '  const user = (d && d.user) || d || {};',
  '  const org = user.orgId || user.org_id || (d && (d.orgId || d.org_id));',
  "  if (org) pm.environment.set('org_id', String(org));",
  "  pm.test('Login returned a token', function () { pm.expect(token, 'token').to.be.ok; });",
  '} catch (e) {',
  "  console.log('Login capture skipped:', e.message);",
  '}'
];

function makeRequest(ep, isLogin) {
  const isWrite = ['POST', 'PUT', 'PATCH'].includes(ep.method);
  const headers = [{ key: 'x-org-id', value: '{{org_id}}' }];
  if (isWrite) headers.push({ key: 'Content-Type', value: 'application/json' });

  const request = {
    method: ep.method,
    header: headers,
    url: urlObject(ep.fullPath)
  };
  if (isWrite) {
    // The login request is pre-filled with the env credentials so it
    // works the moment the collection is imported.
    const skeleton = isLogin
      ? { email: '{{email}}', password: '{{password}}' }
      : (ep.bodyFields.length
        ? ep.bodyFields.reduce((o, f) => { o[f] = ''; return o; }, {})
        : {});
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(skeleton, null, 2),
      options: { raw: { language: 'json' } }
    };
  }
  if (ep.bodyFields.length) {
    request.description = `Body fields detected from validators: ${ep.bodyFields.join(', ')}`;
  }

  const testScript = isLogin ? [...STATUS_TEST, '', ...LOGIN_CAPTURE] : STATUS_TEST;
  return {
    name: `${ep.method} ${ep.sub || '/'}`,
    request,
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: testScript } }],
    response: []
  };
}

// Category → [module folder]
const byCategory = {};
for (const mod of modules) {
  const cat = categoryOf(mod.mountPath);
  byCategory[cat] = byCategory[cat] || [];
  const isAuthModule = mod.mountPath === '/api/v1/auth';
  byCategory[cat].push({
    name: `${mod.name}  ·  ${mod.mountPath}`,
    description: `Source: ${mod.file}`,
    item: mod.endpoints.map((ep) =>
      makeRequest(ep, isAuthModule && /login/i.test(ep.sub))
    )
  });
}

const CATEGORY_ORDER = ['Auth', 'Platform (tenant)', 'Public', 'Admin (Calcite SuperAdmin)', 'Webhooks'];
const collectionItems = CATEGORY_ORDER
  .filter((c) => byCategory[c])
  .map((c) => ({
    name: c,
    item: byCategory[c].sort((a, b) => a.name.localeCompare(b.name))
  }));

const totalEndpoints = modules.reduce((n, m) => n + m.endpoints.length, 0);

// ── 5. Assemble the collection ──────────────────────────────────────
const collection = {
  info: {
    name: 'Stewardex API',
    description:
      `Auto-generated from the Express routes (${totalEndpoints} endpoints across `
      + `${modules.length} modules).\n\n`
      + 'Setup:\n'
      + '1. Import this collection AND Stewardex.postman_environment.json.\n'
      + '2. Select the "Stewardex — Local" environment (top-right).\n'
      + '3. Run Auth › Login — it captures the JWT into {{token}} + {{org_id}}.\n'
      + '4. Every other request then sends Authorization: Bearer {{token}} '
      + 'and the x-org-id header automatically.\n\n'
      + 'POST/PUT/PATCH bodies are skeletons built from express-validator '
      + 'body() fields where detectable — fill in real values.\n\n'
      + 'Regenerate with: node postman/generate-postman.mjs',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  event: [
    {
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// Runs before every request.',
          "if (!pm.environment.get('base_url') && !pm.collectionVariables.get('base_url')) {",
          "  console.warn('base_url not set — select the Stewardex environment (top-right).');",
          '}'
        ]
      }
    }
  ],
  variable: [
    { key: 'base_url', value: 'http://localhost:5000' },
    { key: 'token', value: '' },
    { key: 'org_id', value: '' }
  ],
  item: collectionItems
};

// ── 6. The environment ──────────────────────────────────────────────
const environment = {
  name: 'Stewardex — Local',
  values: [
    { key: 'base_url', value: 'http://localhost:5000', type: 'default', enabled: true },
    { key: 'token', value: '', type: 'secret', enabled: true },
    { key: 'org_id', value: '', type: 'default', enabled: true },
    { key: 'email', value: 'admin@example.com', type: 'default', enabled: true },
    { key: 'password', value: 'ChangeMe123!', type: 'secret', enabled: true },
    // Common path-parameter placeholders — set as you exercise endpoints.
    { key: 'user_id', value: '', type: 'default', enabled: true },
    { key: 'channel_id', value: '', type: 'default', enabled: true },
    { key: 'policy_id', value: '', type: 'default', enabled: true },
    { key: 'expense_id', value: '', type: 'default', enabled: true },
    { key: 'donor_id', value: '', type: 'default', enabled: true },
    { key: 'meeting_id', value: '', type: 'default', enabled: true }
  ],
  _postman_variable_scope: 'environment'
};

// ── 7. Write ────────────────────────────────────────────────────────
fs.writeFileSync(
  path.join(HERE, 'Stewardex.postman_collection.json'),
  JSON.stringify(collection, null, 2)
);
fs.writeFileSync(
  path.join(HERE, 'Stewardex.postman_environment.json'),
  JSON.stringify(environment, null, 2)
);

console.log(`Generated Postman collection: ${totalEndpoints} endpoints, ${modules.length} modules.`);
console.log('  postman/Stewardex.postman_collection.json');
console.log('  postman/Stewardex.postman_environment.json');
