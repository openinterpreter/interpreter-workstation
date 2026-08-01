/**
 * Common websites for URL autocomplete
 * These are popular websites that will be suggested when typing in the URL bar
 */

export interface CommonWebsite {
  name: string;
  url: string;
  domain: string;
  faviconUrl?: string;
}

export const COMMON_WEBSITES: CommonWebsite[] = [
  // Search Engines
  { name: 'Google', url: 'https://www.google.com', domain: 'google.com' },
  { name: 'Bing', url: 'https://www.bing.com', domain: 'bing.com' },
  { name: 'DuckDuckGo', url: 'https://duckduckgo.com', domain: 'duckduckgo.com' },

  // Social Media
  { name: 'YouTube', url: 'https://www.youtube.com', domain: 'youtube.com' },
  { name: 'Twitter / X', url: 'https://x.com', domain: 'x.com' },
  { name: 'Facebook', url: 'https://www.facebook.com', domain: 'facebook.com' },
  { name: 'Instagram', url: 'https://www.instagram.com', domain: 'instagram.com' },
  { name: 'LinkedIn', url: 'https://www.linkedin.com', domain: 'linkedin.com' },
  { name: 'Reddit', url: 'https://www.reddit.com', domain: 'reddit.com' },
  { name: 'TikTok', url: 'https://www.tiktok.com', domain: 'tiktok.com' },
  { name: 'Pinterest', url: 'https://www.pinterest.com', domain: 'pinterest.com' },
  { name: 'Discord', url: 'https://discord.com', domain: 'discord.com' },
  { name: 'Twitch', url: 'https://www.twitch.tv', domain: 'twitch.tv' },

  // Productivity
  { name: 'Gmail', url: 'https://mail.google.com', domain: 'mail.google.com' },
  { name: 'Google Drive', url: 'https://drive.google.com', domain: 'drive.google.com' },
  { name: 'Google Docs', url: 'https://docs.google.com', domain: 'docs.google.com' },
  { name: 'Google Sheets', url: 'https://sheets.google.com', domain: 'sheets.google.com' },
  { name: 'Google Calendar', url: 'https://calendar.google.com', domain: 'calendar.google.com' },
  { name: 'Outlook', url: 'https://outlook.live.com', domain: 'outlook.live.com' },
  { name: 'Notion', url: 'https://www.notion.so', domain: 'notion.so' },
  { name: 'Slack', url: 'https://slack.com', domain: 'slack.com' },
  { name: 'Trello', url: 'https://trello.com', domain: 'trello.com' },
  { name: 'Asana', url: 'https://app.asana.com', domain: 'asana.com' },
  { name: 'Figma', url: 'https://www.figma.com', domain: 'figma.com' },
  { name: 'Canva', url: 'https://www.canva.com', domain: 'canva.com' },

  // Developer
  { name: 'GitHub', url: 'https://github.com', domain: 'github.com' },
  { name: 'GitLab', url: 'https://gitlab.com', domain: 'gitlab.com' },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com', domain: 'stackoverflow.com' },
  { name: 'npm', url: 'https://www.npmjs.com', domain: 'npmjs.com' },
  { name: 'CodePen', url: 'https://codepen.io', domain: 'codepen.io' },
  { name: 'Vercel', url: 'https://vercel.com', domain: 'vercel.com' },
  { name: 'Netlify', url: 'https://www.netlify.com', domain: 'netlify.com' },

  // Shopping
  { name: 'Amazon', url: 'https://www.amazon.com', domain: 'amazon.com' },
  { name: 'eBay', url: 'https://www.ebay.com', domain: 'ebay.com' },
  { name: 'Etsy', url: 'https://www.etsy.com', domain: 'etsy.com' },

  // Entertainment
  { name: 'Netflix', url: 'https://www.netflix.com', domain: 'netflix.com' },
  { name: 'Spotify', url: 'https://open.spotify.com', domain: 'spotify.com' },
  { name: 'Hulu', url: 'https://www.hulu.com', domain: 'hulu.com' },
  { name: 'Disney+', url: 'https://www.disneyplus.com', domain: 'disneyplus.com' },
  { name: 'HBO Max', url: 'https://www.max.com', domain: 'max.com' },
  { name: 'Apple Music', url: 'https://music.apple.com', domain: 'music.apple.com' },

  // News
  { name: 'CNN', url: 'https://www.cnn.com', domain: 'cnn.com' },
  { name: 'BBC', url: 'https://www.bbc.com', domain: 'bbc.com' },
  { name: 'The New York Times', url: 'https://www.nytimes.com', domain: 'nytimes.com' },
  { name: 'The Washington Post', url: 'https://www.washingtonpost.com', domain: 'washingtonpost.com' },
  { name: 'Hacker News', url: 'https://news.ycombinator.com', domain: 'news.ycombinator.com' },
  { name: 'TechCrunch', url: 'https://techcrunch.com', domain: 'techcrunch.com' },
  { name: 'The Verge', url: 'https://www.theverge.com', domain: 'theverge.com' },

  // Reference
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', domain: 'wikipedia.org' },
  { name: 'Wolfram Alpha', url: 'https://www.wolframalpha.com', domain: 'wolframalpha.com' },

  // AI
  { name: 'ChatGPT', url: 'https://chat.openai.com', domain: 'chat.openai.com' },
  { name: 'Claude', url: 'https://claude.ai', domain: 'claude.ai' },
  { name: 'Anthropic', url: 'https://www.anthropic.com', domain: 'anthropic.com' },
  { name: 'OpenAI', url: 'https://openai.com', domain: 'openai.com' },
  { name: 'Midjourney', url: 'https://www.midjourney.com', domain: 'midjourney.com' },

  // Finance
  { name: 'PayPal', url: 'https://www.paypal.com', domain: 'paypal.com' },
  { name: 'Stripe', url: 'https://stripe.com', domain: 'stripe.com' },
  { name: 'Coinbase', url: 'https://www.coinbase.com', domain: 'coinbase.com' },
];

/**
 * Filter websites based on a query string
 * Uses PREFIX matching - "goo" matches "google.com" but not "bing"
 * This is intentional for URL-bar style autocomplete
 */
export function filterWebsites(query: string): CommonWebsite[] {
  if (!query || query.length < 2) return [];

  const lowerQuery = query.toLowerCase();

  return COMMON_WEBSITES.filter(website => {
    // Match by domain prefix (most common case)
    if (website.domain.toLowerCase().startsWith(lowerQuery)) return true;
    // Match by domain with www prefix
    if (`www.${website.domain}`.toLowerCase().startsWith(lowerQuery)) return true;
    // Match by name prefix
    if (website.name.toLowerCase().startsWith(lowerQuery)) return true;
    return false;
  });
}

/**
 * Find the best autocomplete match for Chrome-style inline completion
 * Returns the website that starts with the query (for inline completion)
 */
export function findAutocompleteMatch(query: string): CommonWebsite | null {
  if (!query || query.length < 2) return null;

  const lowerQuery = query.toLowerCase();

  // First, try to match the start of the domain (most common case)
  // e.g., "goo" -> "google.com"
  let match = COMMON_WEBSITES.find(website =>
    website.domain.toLowerCase().startsWith(lowerQuery)
  );

  if (match) return match;

  // Try matching "www." prefix
  match = COMMON_WEBSITES.find(website => {
    const domainWithWww = `www.${website.domain}`;
    return domainWithWww.toLowerCase().startsWith(lowerQuery);
  });

  if (match) return match;

  // Try matching the name
  match = COMMON_WEBSITES.find(website =>
    website.name.toLowerCase().startsWith(lowerQuery)
  );

  return match ?? null;
}
