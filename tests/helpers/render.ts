import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, type AnyRoute } from '@tanstack/react-router';

/**
 * Loads the application's own `.tsx` modules for a test, through Vite's server-side module loader (the same transform
 * the build uses), so a test renders the real components rather than reading their source. One server per test file;
 * call `close` when done. Its cache is a folder of its own, removed on close: sharing `node_modules/.vite` with a running
 * dev server would make that server re-optimize and lose its pages.
 */
export async function appModules(): Promise<{ load: <T>(path: string) => Promise<T>; close: () => Promise<void> }> {
  const cacheDir = mkdtempSync(join(tmpdir(), 'books-test-vite-'));
  const server: ViteDevServer = await createServer({
    configFile: false, root: fileURLToPath(new URL('../..', import.meta.url)), cacheDir,
    plugins: [react()], appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false },
  });
  return { load: path => server.ssrLoadModule(path) as never, close: async () => { await server.close(); rmSync(cacheDir, { recursive: true, force: true }); } };
}

/**
 * Renders `routes` (children of a plain root) at `path` on the server, after the router has loaded the matches (so a
 * loader that throws is caught by the router), with the router options given (the app's defaults).
 */
export async function renderAt(path: string, routes: (root: AnyRoute) => AnyRoute[], options: Record<string, unknown> = {}): Promise<string> {
  const root = createRootRoute({ component: () => createElement(Outlet) });
  const router = createRouter({ routeTree: root.addChildren(routes(root)), history: createMemoryHistory({ initialEntries: [path] }), ...options } as never);
  await router.load();
  return renderToString(createElement(RouterProvider, { router } as never));
}

/** A route at `path` under `parent` that renders `component`, or whose loader throws `error`. */
export function testRoute(parent: AnyRoute, path: string, { component, error }: { component?: ComponentType; error?: Error }): AnyRoute {
  return createRoute({ getParentRoute: () => parent, path, component: component ?? (() => null), loader: error ? () => { throw error } : undefined } as never) as never;
}

/** Renders one element inside a router at `/`, for components that use router hooks. */
export async function renderInRouter(element: () => ReactNode): Promise<string> {
  return renderAt('/', root => [testRoute(root, '/', { component: () => createElement(() => element()) })]);
}
