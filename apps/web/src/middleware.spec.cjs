const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadMiddleware() {
  const source = readFileSync(join(__dirname, 'middleware.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === 'next/server') {
        return {
          NextResponse: {
            next: () => ({ type: 'next' }),
            redirect: (url) => ({
              type: 'redirect',
              url: url.toString(),
              cookies: { delete: () => {} },
            }),
          },
        };
      }
      return require(specifier);
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    URL,
  };

  vm.runInNewContext(outputText, sandbox);
  return module.exports.middleware;
}

function request(pathname, token) {
  return {
    nextUrl: { pathname },
    url: `https://stock.example.com${pathname}`,
    cookies: {
      get: (name) =>
        name === 'sc_token' && token ? { value: token } : undefined,
    },
  };
}

test('lets protected routes reach client auth when no frontend-domain token exists', () => {
  const middleware = loadMiddleware();

  const response = middleware(request('/'));

  assert.equal(response.type, 'next');
});
