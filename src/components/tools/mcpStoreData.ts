/**
 * MCP Store - Curated list of popular MCP servers
 *
 * These servers use OAuth 2.1 for authentication, which is handled
 * automatically when the server connects.
 */

export type McpStoreCategory =
  | 'productivity'
  | 'finance'
  | 'developer'
  | 'research'
  | 'healthcare'
  | 'data'
  | 'academic';

export const MCP_STORE_CATEGORIES: Record<McpStoreCategory, { label: string; order: number }> = {
  productivity: { label: 'Productivity', order: 1 },
  finance: { label: 'Finance & Payments', order: 2 },
  data: { label: 'Data & Analytics', order: 3 },
  research: { label: 'Research & Life Sciences', order: 4 },
  developer: { label: 'Developer Tools', order: 5 },
  healthcare: { label: 'Healthcare', order: 6 },
  academic: { label: 'Academic', order: 7 },
};

export interface McpStoreEntry {
  id: string;
  name: string;
  description: string;
  url: string;
  domain: string; // For favicon
  transport: 'sse' | 'http';
  headers?: Record<string, string>;
  oauthResource?: string;
  category: McpStoreCategory;
  note?: string; // Optional note (e.g., "Requires production access")
}

export interface McpStoreMatchCandidate {
  id?: string;
  name?: string;
  url?: string;
  command?: string;
  args?: string[];
}

export const MCP_STORE_ENTRIES: McpStoreEntry[] = [
  // ===== PRODUCTIVITY =====
  {
    id: 'asana',
    name: 'Asana',
    description: 'Create, search, and assign tasks and deliverables',
    url: 'https://mcp.asana.com/sse',
    domain: 'asana.com',
    transport: 'sse',
    category: 'productivity',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Track issues, manage sprints, and search knowledge bases',
    url: 'https://mcp.atlassian.com/v1/mcp',
    domain: 'atlassian.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Search for and create issues, projects, and comments',
    url: 'https://mcp.linear.app/mcp',
    domain: 'linear.app',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Read, create, and update pages and databases',
    url: 'https://mcp.notion.com/mcp',
    domain: 'notion.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    description: 'Search and work with files in your Dropbox workspace',
    url: 'https://mcp.dropbox.com/mcp',
    domain: 'dropbox.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'box',
    name: 'Box',
    description: 'Query enterprise files and folders with secure permissions',
    url: 'https://mcp.box.com',
    domain: 'box.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Search, create, and manage design assets and docs',
    url: 'https://mcp.canva.com/mcp',
    domain: 'canva.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'wix',
    name: 'Wix',
    description: 'Manage site content, products, and CMS collections',
    url: 'https://mcp.wix.com/mcp',
    domain: 'wix.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Access bases, records, and automate workflow updates',
    url: 'https://mcp.airtable.com/mcp',
    domain: 'airtable.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'fellow',
    name: 'Fellow',
    description: 'Access meeting notes, transcripts, and action items',
    url: 'https://fellow.app/mcp',
    domain: 'fellow.app',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'fireflies',
    name: 'Fireflies.ai',
    description: 'Search and summarize meeting transcripts',
    url: 'https://api.fireflies.ai/mcp',
    domain: 'fireflies.ai',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Analyze support trends and triage customer issues',
    url: 'https://mcp.intercom.com/mcp',
    domain: 'intercom.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'Search CRM records, contacts, companies, and deals',
    url: 'https://mcp.hubspot.com',
    domain: 'hubspot.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'monday',
    name: 'monday.com',
    description: 'Create and update boards, items, and project workflows',
    url: 'https://mcp.monday.com/mcp',
    domain: 'monday.com',
    transport: 'http',
    category: 'productivity',
  },
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    description: 'Analyze campaigns, audiences, and marketing performance',
    url: 'https://mcp.klaviyo.com/mcp',
    domain: 'klaviyo.com',
    transport: 'http',
    category: 'productivity',
  },

  // ===== FINANCE & PAYMENTS =====
  {
    id: 'ramp',
    name: 'Ramp',
    description: 'Corporate expense and spend management analysis',
    url: 'https://ramp-mcp-remote.ramp.com/mcp',
    domain: 'ramp.com',
    transport: 'http',
    category: 'finance',
  },
  {
    id: 'mercury',
    name: 'Mercury',
    description: 'Read account balances, transactions, and payment activity',
    url: 'https://mcp.mercury.com/mcp',
    domain: 'mercury.com',
    transport: 'http',
    category: 'finance',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'Create invoices and analyze sales activity',
    url: 'https://mcp.paypal.com/sse',
    domain: 'paypal.com',
    transport: 'sse',
    category: 'finance',
  },
  {
    id: 'square',
    name: 'Square',
    description: 'Search transactions, merchants, and payment data',
    url: 'https://mcp.squareup.com/sse',
    domain: 'squareup.com',
    transport: 'sse',
    category: 'finance',
  },
  {
    id: 'plaid',
    name: 'Plaid',
    description: 'Access account and transaction data for financial analysis',
    url: 'https://api.dashboard.plaid.com/mcp/sse',
    domain: 'plaid.com',
    transport: 'sse',
    category: 'finance',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Work with customers, payments, subscriptions, and billing data',
    url: 'https://mcp.stripe.com/',
    domain: 'stripe.com',
    transport: 'http',
    category: 'finance',
  },

  // ===== DEVELOPER TOOLS =====
  {
    id: 'github',
    name: 'GitHub',
    description: 'Search code, issues, pull requests, and repository activity',
    url: 'https://api.githubcopilot.com/mcp/',
    domain: 'github.com',
    transport: 'http',
    category: 'developer',
    note: 'Uses a GitHub token from GitHub CLI auth or GH_TOKEN/GITHUB_TOKEN.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Search, query, and debug errors intelligently',
    url: 'https://mcp.sentry.dev/mcp',
    domain: 'sentry.io',
    transport: 'http',
    category: 'developer',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage projects, run SQL, and inspect logs with AI',
    url: 'https://mcp.supabase.com/mcp',
    oauthResource: 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp',
    domain: 'supabase.com',
    transport: 'http',
    category: 'developer',
  },

  // ===== DATA & ANALYTICS =====
  {
    id: 'explorium',
    name: 'Explorium',
    description: 'B2B company and contact data enrichment',
    url: 'https://mcp-claude-web.explorium.ai/mcp',
    domain: 'explorium.ai',
    transport: 'http',
    category: 'data',
  },
  {
    id: 'windsor',
    name: 'Windsor.ai',
    description: 'Query marketing and business data from 325+ sources',
    url: 'https://mcp.windsor.ai',
    domain: 'windsor.ai',
    transport: 'http',
    category: 'data',
  },

  // ===== RESEARCH & LIFE SCIENCES =====
  {
    id: 'pubmed',
    name: 'PubMed',
    description: 'Search 36M+ biomedical research citations',
    url: 'https://pubmed.mcp.claude.com/mcp',
    domain: 'pubmed.ncbi.nlm.nih.gov',
    transport: 'http',
    category: 'research',
  },
  {
    id: 'opentargets',
    name: 'Open Targets',
    description: 'Drug target discovery and disease associations',
    url: 'https://mcp.platform.opentargets.org/mcp',
    domain: 'opentargets.org',
    transport: 'http',
    category: 'research',
  },

  // ===== HEALTHCARE =====

  // ===== ACADEMIC =====
  {
    id: 'scholar-gateway',
    name: 'Scholar Gateway',
    description: 'Search 3M+ Wiley peer-reviewed articles',
    url: 'https://connector.scholargateway.ai/mcp',
    domain: 'wiley.com',
    transport: 'http',
    category: 'academic',
    note: 'Beta - free trial through Jan 2026',
  },
];

/**
 * Get entries grouped by category
 */
export function getEntriesByCategory(): Map<McpStoreCategory, McpStoreEntry[]> {
  const grouped = new Map<McpStoreCategory, McpStoreEntry[]>();

  for (const entry of MCP_STORE_ENTRIES) {
    const existing = grouped.get(entry.category) || [];
    existing.push(entry);
    grouped.set(entry.category, existing);
  }

  return grouped;
}

/**
 * Get sorted categories
 */
export function getSortedCategories(): McpStoreCategory[] {
  return (Object.keys(MCP_STORE_CATEGORIES) as McpStoreCategory[]).sort(
    (a, b) => MCP_STORE_CATEGORIES[a].order - MCP_STORE_CATEGORIES[b].order
  );
}

/**
 * Get favicon URL for a domain using Google's favicon service
 */
export function getFaviconUrl(domain: string, size: number = 64): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}

function extractHost(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function matchStoreEntryForCandidate(
  candidate: McpStoreMatchCandidate,
  entries: McpStoreEntry[] = MCP_STORE_ENTRIES
): McpStoreEntry | null {
  const candidateHost = extractHost(candidate.url);
  if (candidateHost) {
    const hostMatch = entries.find((entry) => extractHost(entry.url) === candidateHost);
    if (hostMatch) return hostMatch;
  }

  const candidateId = candidate.id?.trim().toLowerCase();
  if (candidateId) {
    const idMatch = entries.find((entry) => entry.id.toLowerCase() === candidateId);
    if (idMatch) return idMatch;
  }

  const candidateName = candidate.name?.trim().toLowerCase();
  if (candidateName) {
    const nameMatch = entries.find((entry) => entry.name.toLowerCase() === candidateName);
    if (nameMatch) return nameMatch;
  }

  return null;
}
