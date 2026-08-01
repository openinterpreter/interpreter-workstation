/**
 * Provider configuration storage
 *
 * Handles CRUD operations for providers stored in codex-home/config.toml
 * Similar pattern to MCP servers in configStore.ts
 */

import { loadConfigWithModelState, saveConfig } from '../configStore';
import type { Provider } from '../../shared/types/provider';
import {
  BUILTIN_PROVIDERS,
  isBuiltinProvider,
  getBuiltinProviderDefaults,
} from '../../shared/types/provider';

/**
 * Get all providers (built-in + custom)
 * Built-in providers may have customizations stored in config
 */
export async function listProviders(): Promise<Provider[]> {
  const config = await loadConfigWithModelState();
  const storedProviders = config.providers || {};

  // Start with built-in providers, applying any stored customizations
  const builtinWithCustomizations = BUILTIN_PROVIDERS.map(builtin => {
    const customized = storedProviders[builtin.id];
    return customized || builtin;
  });

  // Add custom (non-builtin) providers
  const customProviders = Object.values(storedProviders).filter(
    p => !isBuiltinProvider(p.id)
  );

  return [...builtinWithCustomizations, ...customProviders];
}

/**
 * Get a provider by ID
 */
export async function getProvider(providerId: string): Promise<Provider | undefined> {
  const config = await loadConfigWithModelState();
  const storedProviders = config.providers || {};

  // Check stored providers first (includes customized builtins)
  const stored = storedProviders[providerId];
  if (stored) return stored;

  // Fall back to default builtin provider
  return getBuiltinProviderDefaults(providerId);
}

/**
 * Add a new custom provider
 */
export async function addProvider(provider: Provider): Promise<void> {
  if (isBuiltinProvider(provider.id)) {
    throw new Error('Cannot add a provider with a built-in ID');
  }

  const config = await loadConfigWithModelState();
  if (!config.providers) {
    config.providers = {};
  }

  // Check for duplicate ID
  if (config.providers[provider.id]) {
    throw new Error(`Provider with ID ${provider.id} already exists`);
  }

  const now = Date.now();
  config.providers[provider.id] = {
    ...provider,
    createdAt: now,
    updatedAt: now,
  };

  await saveConfig(config);
}

/**
 * Update an existing provider (both builtin and custom)
 * Builtin providers can have their settings customized
 */
export async function updateProvider(
  providerId: string,
  updates: Partial<Provider>
): Promise<void> {
  const config = await loadConfigWithModelState();
  if (!config.providers) {
    config.providers = {};
  }

  const isBuiltin = isBuiltinProvider(providerId);
  const existing = config.providers[providerId];

  if (isBuiltin) {
    // For builtin providers, get the base defaults and merge with updates
    const defaults = getBuiltinProviderDefaults(providerId);
    if (!defaults) {
      throw new Error(`Builtin provider ${providerId} not found`);
    }

    config.providers[providerId] = {
      ...defaults,
      ...(existing || {}),
      ...updates,
      id: providerId, // Prevent ID from being changed
      updatedAt: Date.now(),
    };
  } else {
    // Custom provider - must exist
    if (!existing) {
      throw new Error(`Provider ${providerId} not found`);
    }

    config.providers[providerId] = {
      ...existing,
      ...updates,
      id: providerId, // Prevent ID from being changed
      updatedAt: Date.now(),
    };
  }

  await saveConfig(config);
}

/**
 * Delete a custom provider
 */
export async function deleteProvider(providerId: string): Promise<void> {
  if (isBuiltinProvider(providerId)) {
    throw new Error('Cannot delete built-in providers');
  }

  const config = await loadConfigWithModelState();
  if (!config.providers) return;

  delete config.providers[providerId];
  await saveConfig(config);
}

/**
 * Reset a built-in provider to its original defaults
 */
export async function resetProvider(providerId: string): Promise<Provider> {
  const defaults = getBuiltinProviderDefaults(providerId);
  if (!defaults) {
    throw new Error(`Provider ${providerId} is not a built-in provider and cannot be reset`);
  }

  const config = await loadConfigWithModelState();
  if (!config.providers) {
    config.providers = {};
  }

  // Remove any customizations
  delete config.providers[providerId];
  await saveConfig(config);

  return defaults;
}

/**
 * Generate a unique provider ID from a name
 */
export function generateProviderId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `custom:${slug}-${Date.now().toString(36)}`;
}
