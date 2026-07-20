// NannyCam landing page — static content only, no app state. Styling lives
// in index.css (external stylesheet, same convention as camera/main.tsx and
// viewer/main.tsx) because the production CSP has no style-src override, so
// an inline <style> block would be silently blocked.
import './index.css';
