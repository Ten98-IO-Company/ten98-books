import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import { AuthFrameProvider, createThemeScript, ToastProvider } from '@ten98/ui';
import { AppBrand } from '@ten98/ui/app';
import appTokens from '@ten98/ui/app-tokens.css?url';
import styles from '@ten98/ui/styles.css?url';
import appStyles from '@ten98/ui/app.css?url';
import productStyles from '@ten98/ui/product.css?url';
import { authStory } from '../components/AuthLayout';
import { getConfig } from '../server/config.ts';
import { AppStateScreen, Stack } from '@ten98/ui';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Books' }],
    links: [appTokens, styles, appStyles, productStyles].map(href => ({ rel: 'stylesheet', href })),
    // Sets the cached theme before the first paint. TanStack Start gives head scripts the response's nonce, so the policy below needs no
    // 'unsafe-inline'. Until the package acts once per document (@ten98/ui 0.39.2), the router can run this script again on client
    // navigations: with blocked storage or a stale cached value the theme can change for a frame on some page changes.
    scripts: [{ children: createThemeScript() }],
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
  // suppressHydrationWarning: the theme script sets data-theme on <html> before React hydrates, which the server markup lacks.
  component: () => <html lang='en' suppressHydrationWarning><head><HeadContent /></head><body><ToastProvider><AuthFrameProvider brand={<AppBrand product='Books' />} aside={authStory}><Outlet /></AuthFrameProvider></ToastProvider><Scripts /></body></html>,
  notFoundComponent: RootNotFound,
  errorComponent: RootError,
});

/**
 * An address no route matches, outside the signed-in shell (inside it the /app route's own screen applies): the same
 * screen for every visitor, signed in or not, whatever the address, with a link to the start page. Its heading takes
 * focus, so focus is not left on the page body.
 */
function RootNotFound() {
  return <RootState state='not-found' title='Page not found' message='This address does not open a page of the application.' />;
}

/** A failure outside the shell: a fixed message and "Try again" only. The error itself (its message, stack or request) is never shown. */
function RootError({ reset }: ErrorComponentProps) {
  return <RootState state='error' title='This page could not be shown' message='Something went wrong while showing this page.' onRetry={reset} />;
}

function RootState({ state, title, message, onRetry }: { state: 'not-found' | 'error'; title: string; message: string; onRetry?: () => void }) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    const heading = region.current?.querySelector<HTMLElement>('h1, h2');
    if (heading) { heading.tabIndex = -1; heading.focus(); } else region.current?.focus();
  }, []);
  return <Stack ref={region} tabIndex={-1} role='region' aria-label={title}>
    <AppStateScreen state={state} title={title} message={message} onRetry={onRetry} homeHref={state === 'not-found' ? '/' : undefined} retryLabel={state === 'not-found' ? 'Go to the start page' : 'Try again'} />
  </Stack>;
}
