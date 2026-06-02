// Client-side redirect component used by the redirectsPlugin in index.js.
// Docusaurus pre-renders this to a small static HTML file at build time; the
// useEffect runs on hydration in the browser and replaces the current URL with
// the target. Returns null so there is no visible flash of empty page content
// beyond what Docusaurus's chrome (navbar/footer) renders.
import {useEffect} from 'react';

export default function Redirect({target}) {
  useEffect(() => {
    if (target && target.to) {
      window.location.replace(target.to);
    }
  }, [target]);
  return null;
}
