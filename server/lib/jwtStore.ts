/**
 * Simple in-memory JWT cache for server-side API calls
 *
 * The JWT is set from each incoming request's Authorization header.
 * Subagents and tools can access it via getServerJWT().
 *
 * No persistence - frontend always passes JWT with requests.
 */

let cachedJWT: string | null = null;

/**
 * Set the JWT token (called at start of each request)
 */
export function setServerJWT(token: string | null) {
  if (token) {
    cachedJWT = token;
  }
}

/**
 * Get the current JWT token (used by subagents/tools)
 */
export function getServerJWT(): string | null {
  return cachedJWT;
}

/**
 * Clear the JWT (called on logout)
 */
export function clearServerJWT() {
  cachedJWT = null;
}

