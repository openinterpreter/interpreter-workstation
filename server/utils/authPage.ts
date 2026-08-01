/**
 * Shared auth page HTML template
 * Matches the style of AuthCallback.tsx
 */
export function authPage(status: string, autoClose = false): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: white;
      color: #0a0a0a;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0a0a0a; color: #fafafa; }
      .card { background: #141414; color: #fafafa; box-shadow: 0 8px 30px rgba(0,0,0,0.4); }
    }
    .card {
      background: white;
      color: #0a0a0a;
      border: none;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.08);
      max-width: 28rem;
      padding: 2rem;
      margin: 1rem;
    }
    .title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .status {
      font-size: 0.875rem;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Authentication</div>
    <p class="status">${status}</p>
  </div>
  ${autoClose ? `<script>
    setTimeout(function() { try { window.close(); } catch(e) {} }, 2000);
  </script>` : ''}
</body>
</html>`;
}
