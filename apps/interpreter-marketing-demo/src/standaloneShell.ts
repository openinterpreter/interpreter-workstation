const THEME_PARAM = "theme";
const STYLE_ID = "marketing-demo-standalone-shell";

function getSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function getTheme(): "light" | "dark" {
  const theme = getSearchParams().get(THEME_PARAM);
  if (theme === "dark") {
    return "dark";
  }
  if (theme === "light") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function hasExplicitTheme(): boolean {
  const theme = getSearchParams().get(THEME_PARAM);
  return theme === "light" || theme === "dark";
}

function ensureStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  document.head.appendChild(style);
  return style;
}

function applyStandaloneShell(): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  const body = document.body;
  if (!body) {
    return;
  }

  const theme = getTheme();
  const shellBackground = theme === "dark" ? "#111112" : "#f7f7f8";
  root.dataset.marketingDemoTheme = theme;
  body.dataset.marketingDemoTheme = theme;
  root.classList.toggle("dark", theme === "dark");
  body.classList.toggle("dark", theme === "dark");

  const style = ensureStyleElement();
  style.textContent = `
    :root {
      color-scheme: ${theme};
    }

    html, body {
      width: 100%;
      min-height: 100%;
      height: 100%;
      background: ${shellBackground};
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      box-sizing: border-box;
      overflow: hidden;
      background: ${shellBackground};
    }

    #root {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: ${shellBackground};
    }
  `;

  root.style.colorScheme = theme;
  body.style.colorScheme = theme;
}

function startStandaloneShell(): void {
  applyStandaloneShell();
  if (hasExplicitTheme()) {
    return;
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = () => applyStandaloneShell();
  mediaQuery.addEventListener("change", handleChange);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startStandaloneShell, { once: true });
} else {
  startStandaloneShell();
}
