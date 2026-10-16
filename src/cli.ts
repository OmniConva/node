import { signRequest } from './signature';
import { createOmniConva } from './index';

/**
 * npx omniconva-test [--url http://localhost:3000/omniconva] [--offline]
 *
 * Checks your setup the way OmniConva will use it: signed requests to your
 * health and products routes, then a ping to OmniConva with your webhook
 * token and signing secret. Reads OMNICONVA_* from the environment (and
 * from .env in the current directory when present).
 */
async function main() {
  await loadDotEnv();
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const urlArg = args.find((arg) => arg.startsWith('--url='))?.slice(6) ?? (urlIndex >= 0 ? args[urlIndex + 1] : undefined);
  const base = urlArg ?? process.env.OMNICONVA_TEST_URL ?? 'http://localhost:3000/omniconva';
  const offline = args.includes('--offline');
  const secret = process.env.OMNICONVA_SIGNING_SECRET ?? '';
  let failed = false;

  const check = async (label: string, run: () => Promise<string>) => {
    try {
      console.log(`  ✓ ${label}: ${await run()}`);
    } catch (error) {
      failed = true;
      console.log(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  console.log('Checking OmniConva\n');
  await check('Credentials in the environment', async () => {
    const missing = ['OMNICONVA_WEBHOOK_URL', 'OMNICONVA_WEBHOOK_TOKEN', 'OMNICONVA_SIGNING_SECRET'].filter(
      (name) => !process.env[name],
    );
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
    return 'set';
  });

  for (const path of ['/health', '/products?page=1&per_page=2']) {
    await check(`GET ${base}${path.split('?')[0]}`, async () => {
      const url = new URL(base.replace(/\/+$/, '') + path);
      const response = await fetch(url, {
        headers: { 'x-omniconva-signature': signRequest(secret, 'GET', url.pathname + url.search, '') },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      const body = JSON.parse(text) as { products?: unknown[]; total?: number | null; version?: string; framework?: string };
      return body.products
        ? `${body.total ?? body.products.length} product(s), first page reads fine`
        : `${body.version ? `@omniconva/node ${body.version}` : 'ok'}${body.framework ? ` on ${body.framework}` : ''}`;
    });
  }

  if (!offline) {
    await check('OmniConva accepts the token and signature', async () => {
      const result = await createOmniConva().ping();
      return result.store ? `store ${result.store}` : 'ok';
    });
  }

  console.log(
    failed
      ? '\nFix the items above, then run this again.'
      : '\nAll good. In OmniConva, press "Check package", then "Connect website".',
  );
  process.exit(failed ? 1 : 0);
}

async function loadDotEnv() {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile('.env', 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(OMNICONVA_[A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1] && process.env[match[1]] === undefined) {
        process.env[match[1]] = (match[2] ?? '').replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env: fine
  }
}

void main();
