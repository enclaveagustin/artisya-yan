// Inlines offline-dist/offline.js into one self-contained HTML page: docs/index.html, the landing page.
// (docs/offline.html stays as a tiny redirect so older links keep working; the old online scanner
// lives at docs/scanner.html.)
// The page ships a Content-Security-Policy that forbids every network request
// (connect-src 'none', no external scripts/styles/images/frames), so the
// "nothing leaves your device" promise is enforced by the browser, not just stated.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'offline-dist', 'offline.js'), 'utf8')
  // A literal </script in the bundle would end the inline script early.
  .replace(/<\/script/gi, '<\\/script');

const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  "connect-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<title>Artisya Yan?! (offline follow-back checker)</title>
</head>
<body>
<noscript>This page needs JavaScript to read your files. Nothing is sent anywhere.</noscript>
<div id="root"></div>
<script>${script}</script>
</body>
</html>
`;

fs.writeFileSync(path.join(root, 'docs', 'index.html'), html);

// A relative target (not "./") so it also works when the files are opened from disk.
const redirect = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=index.html">
<title>Artisya Yan?!</title>
</head>
<body><a href="index.html">Continue to Artisya Yan?!</a></body>
</html>
`;
fs.writeFileSync(path.join(root, 'docs', 'offline.html'), redirect);

console.log(`docs/index.html written (${Math.round(html.length / 1024)} KB), docs/offline.html is a redirect`);
