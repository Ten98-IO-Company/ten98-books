import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { AuthFrameProvider, ToastProvider } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';
import appTokens from '@ten98/ui/app-tokens.css?url';
import styles from '@ten98/ui/styles.css?url';
import appStyles from '@ten98/ui/app.css?url';
import productStyles from '@ten98/ui/product.css?url';
import { authStory } from '../components/AuthLayout';
import { getConfig } from '../server/config.ts';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Books' }],
    links: [appTokens, styles, appStyles, productStyles].map(href => ({ rel: 'stylesheet', href })),
  }),
  // Server-rendered documents only: the nonce exists in production SSR (src/router.tsx), server routes answer with
  // their own Response, and the client build deletes this option together with the getConfig import.
  headers: ({ ssr }) => ssr?.nonce ? {
    'content-security-policy': `default-src 'none'; script-src 'self' 'nonce-${ssr.nonce}'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cache-control': 'no-store',
    ...(getConfig().appUrl.startsWith('https:') ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  } : {},
  component: () => <html lang='en'><head><HeadContent /></head><body><ToastProvider><AuthFrameProvider brand={<AppBrand product='Books' />} aside={authStory}><Outlet /></AuthFrameProvider></ToastProvider><Scripts /></body></html>,
});
