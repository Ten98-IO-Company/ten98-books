import './lib/zod-browser'; // must stay the first import: it configures zod before any schema module below is evaluated
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { ErrorScreen } from './components/KeyboardShell';

export const getRouter = () => {
  // One nonce per server-rendered document; the root route turns it into the Content-Security-Policy header.
  // ponytail: dev mode serves no policy (Vite HMR and the React-refresh preamble are inline); upgrade path is a Report-Only variant.
  // Every route catches its own failure (defaultErrorComponent), so a page that fails inside the signed-in shell keeps the
  // shell, its keys and Escape around the error screen; the root route has its own for a failure of the document itself.
  return createRouter({ routeTree, scrollRestoration: true, defaultErrorComponent: ErrorScreen, ssr: import.meta.env.PROD && typeof window === 'undefined' ? { nonce: crypto.randomUUID().replaceAll('-', '') } : undefined });
};
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
