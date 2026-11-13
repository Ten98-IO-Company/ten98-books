import './lib/zod-browser'; // must stay the first import: it configures zod before any schema module below is evaluated
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export const getRouter = () => {
  // One nonce per server-rendered document; the root route turns it into the Content-Security-Policy header.
  // ponytail: dev mode serves no policy (Vite HMR and the React-refresh preamble are inline); upgrade path is a Report-Only variant.
  return createRouter({ routeTree, scrollRestoration: true, ssr: import.meta.env.PROD && typeof window === 'undefined' ? { nonce: crypto.randomUUID().replaceAll('-', '') } : undefined });
};
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
