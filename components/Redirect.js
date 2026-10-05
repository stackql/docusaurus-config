// Client-side redirect component used by the redirectsPlugin in index.js.
// Docusaurus pre-renders this to a small static HTML file at build time; the
// useEffect runs on hydration in the browser and replaces the current URL with
// the target. Renders no body content, so nothing shows beyond Docusaurus's
// chrome (navbar/footer); the meta refresh covers clients without JS.
//
// `react` and `@docusaurus/Head` resolve through the consumer site's webpack
// aliases (this file is bundled as @site/.shared-config/components/Redirect.js),
// not through node resolution from this vendored folder, so they are safe
// under every Yarn nodeLinker.
import {useEffect} from 'react';
import Head from '@docusaurus/Head';

export default function Redirect({target}) {
  const to = target && target.to;
  useEffect(() => {
    if (to) {
      window.location.replace(to);
    }
  }, [to]);
  // A redirect page is not content. The canonical tells crawlers which page
  // this URL stands for, and the zero-second meta refresh is the redirect for
  // clients without JS (search engines treat it as a redirect). No noindex:
  // combined with a canonical it is a contradictory signal, and a redirect
  // never gets indexed anyway. The routes are kept out of the sitemap in
  // index.js (createConfig's ignorePatterns / redirectRoutes).
  return (
    <Head>
      {to ? <meta httpEquiv="refresh" content={`0; url=${to}`} /> : null}
      {to ? <link rel="canonical" href={to} /> : null}
    </Head>
  );
}
