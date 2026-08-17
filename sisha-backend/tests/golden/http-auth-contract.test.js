const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const originalLoad = Module._load;

const identities = {
  'operator-token': {
    auth: { id: 'auth-operator', email: 'operador@example.mil' },
    authorized: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'operador@example.mil',
      role: 'operador',
      active: true,
    },
  },
  'admin-token': {
    auth: { id: 'auth-admin', email: 'admin@example.mil' },
    authorized: {
      id: '00000000-0000-4000-8000-000000000002',
      email: 'admin@example.mil',
      role: 'admin',
      active: true,
    },
  },
  'dono-token': {
    auth: { id: 'auth-dono', email: 'dono@example.mil' },
    authorized: {
      id: '00000000-0000-4000-8000-000000000003',
      email: 'dono@example.mil',
      role: 'dono',
      active: true,
    },
  },
  'inactive-token': {
    auth: { id: 'auth-inactive', email: 'inativo@example.mil' },
    authorized: {
      id: '00000000-0000-4000-8000-000000000004',
      email: 'inativo@example.mil',
      role: 'operador',
      active: false,
    },
  },
};

let tokenBeingResolved = null;

Module._load = function mockedLoad(request, parent, isMain) {
  if (
    parent?.filename?.endsWith('authMiddleware.js')
    && request === '../services/supabaseAuthService'
  ) {
    return {
      async getAuthUserFromToken(token) {
        const identity = identities[token];
        if (!identity) {
          const error = new Error('Sessao Supabase invalida.');
          error.code = 'INVALID_SUPABASE_TOKEN';
          throw error;
        }
        tokenBeingResolved = token;
        return identity.auth;
      },
    };
  }

  if (
    parent?.filename?.endsWith('authMiddleware.js')
    && request === '../services/authIdentityBindingService'
  ) {
    return {
      async resolveAuthorizedUserForAuthUser(authUser) {
        const identity = identities[tokenBeingResolved];
        if (!identity || identity.auth.id !== authUser.id) return null;
        return identity.authorized;
      },
    };
  }

  if (
    parent?.filename?.endsWith('authMiddleware.js')
    && request === '../config/supabaseAdminClient'
  ) {
    return {
      getSupabaseAdmin() {
        throw new Error('H5E: banco real nao pode ser acessado.');
      },
    };
  }

  if (
    parent?.filename?.endsWith('authMiddleware.js')
    && request === '../utils/auditLogger'
  ) {
    return {
      isGodUser(user) {
        return user?.role === 'dono';
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const {
  requireAuth,
  requireRole,
} = require('../../src/middlewares/authMiddleware');

Module._load = originalLoad;

const {
  requestContextMiddleware,
} = require('../../src/middlewares/requestContextMiddleware');

function decorateResponse(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };

  res.json = function json(payload) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(payload));
    return res;
  };

  return res;
}

function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const next = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(true);
    };

    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
      return originalEnd(...args);
    };

    Promise.resolve(middleware(req, res, next)).catch(reject);
  });
}

async function authChain(req, res, role = null) {
  const authenticated = await runMiddleware(requireAuth, req, res);
  if (!authenticated) return false;

  if (role) {
    return runMiddleware(requireRole(role), req, res);
  }

  return true;
}

const server = http.createServer(async (req, rawRes) => {
  const res = decorateResponse(rawRes);

  try {
    await new Promise((resolve, reject) => {
      requestContextMiddleware(req, res, (error) => (
        error ? reject(error) : resolve()
      ));
    });

    if (req.url === '/api/health') {
      return res.status(200).json({
        status: 'success',
        message: 'Servidor SISHA-1 Operacional!',
      });
    }

    if (req.url.startsWith('/api/import')) {
      const allowed = await authChain(req, res, ['admin']);
      if (!allowed) return;
      return res.status(404).json({ status: 'error', message: 'Rota de teste inexistente.' });
    }

    if (req.url === '/api/receipts' && req.method === 'POST') {
      const allowed = await authChain(req, res, ['admin']);
      if (!allowed) return;
      return res.status(204).end();
    }

    if (req.url.startsWith('/api/stats')) {
      const allowed = await authChain(req, res);
      if (!allowed) return;
      return res.status(204).end();
    }

    return res.status(404).json({ status: 'error', message: 'Nao encontrado.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

let origin;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, origin);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          json = null;
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('GOLDEN HTTP: health responde 200 e JSON operacional', async () => {
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.json?.status, 'success');
  assert.match(response.json?.message || '', /SISHA-1 Operacional/i);
  assert.match(response.headers['content-type'] || '', /application\/json/i);
});

test('GOLDEN HTTP: Request-ID valido do cliente e preservado', async () => {
  const response = await request('/api/health', {
    headers: { 'X-Request-Id': 'h5e-http-golden-001' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['x-sisha-request-id'], 'h5e-http-golden-001');
});

test('GOLDEN HTTP: Request-ID invalido e substituido por UUID', async () => {
  const response = await request('/api/health', {
    headers: { 'X-Request-Id': 'id invalido !!!' },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers['x-sisha-request-id'] || '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test('GOLDEN HTTP: area protegida sem Bearer retorna 401', async () => {
  const response = await request('/api/stats');
  assert.equal(response.status, 401);
  assert.equal(response.json?.status, 'error');
  assert.equal(response.json?.message, 'Acesso não autorizado.');
  assert.ok(response.headers['x-sisha-request-id']);
});

test('GOLDEN HTTP: token legado/invalido retorna 401', async () => {
  const response = await request('/api/stats', {
    headers: { Authorization: 'Bearer legacy-or-invalid-token' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.json?.message, 'Sessao Supabase invalida.');
});

test('GOLDEN HTTP: usuario local inativo retorna 401 mesmo com Auth valido', async () => {
  const response = await request('/api/stats', {
    headers: { Authorization: 'Bearer inactive-token' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.json?.message, 'Usuário desativado no SISHA.');
});

test('GOLDEN HTTP: Operador recebe 403 em superficie administrativa', async () => {
  const response = await request('/api/import/__h5e__', {
    headers: { Authorization: 'Bearer operator-token' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.json?.message, 'Perfil sem permissão para esta operação.');
});

test('GOLDEN HTTP: Admin atravessa o gate administrativo', async () => {
  const response = await request('/api/import/__h5e__', {
    headers: { Authorization: 'Bearer admin-token' },
  });
  assert.equal(response.status, 404);
});

test('GOLDEN HTTP: Dono herda permissao administrativa', async () => {
  const response = await request('/api/import/__h5e__', {
    headers: { Authorization: 'Bearer dono-token' },
  });
  assert.equal(response.status, 404);
});

test('GOLDEN HTTP: Operador recebe 403 em mutacao de Recebimentos', async () => {
  const response = await request('/api/receipts', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer operator-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ documento: 'H5E-NAO-CHEGA-AO-CONTROLLER' }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.json?.message, 'Perfil sem permissão para esta operação.');
});
