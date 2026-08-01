/**
 * useEnvironmentDetection
 *
 * Hook that triggers silent environment detection on mount by calling
 * the IPC detection route. Results are stored in OnboardingContext.
 *
 * Detection runs in parallel with the name input screen. By the time
 * the user finishes typing their name and hits Enter, detection should
 * be complete.
 */

import { useEffect, useRef } from 'react';
import { environmentDetection } from '../../../ipc';
import { useOnboarding } from '../OnboardingContext';
import type { DetectionResults, OnboardingBucket } from '../OnboardingContext';

/**
 * Detection signals returned from the IPC route.
 */
interface EnvironmentDetectionSignals {
  commands: Record<string, boolean>;
  configDirs: Record<string, boolean>;
  applications: string[];
  envVars: Record<string, boolean>;
  platform: string;
}

/**
 * Persona derivation returned by the server.
 */
interface PersonaResult {
  bucket: OnboardingBucket;
  subCategories: string[];
  detectedProviders: string[];
  detectedTools: {
    has_claude_cli: boolean;
    has_ollama: boolean;
    has_lmstudio: boolean;
    has_cursor: boolean;
    has_vscode: boolean;
  };
  confident: boolean;
}

interface EnvironmentDetectionResponse {
  signals: EnvironmentDetectionSignals;
  persona: PersonaResult;
}

export function useEnvironmentDetection() {
  const { setDetectionResults, isDetectionComplete } = useOnboarding();
  const hasStarted = useRef(false);

  useEffect(() => {
    // Only run once
    if (hasStarted.current || isDetectionComplete) return;
    hasStarted.current = true;

    async function runDetection() {
      try {
        const detection = await environmentDetection.detect() as EnvironmentDetectionResponse;

        const detectedCommands = Object.entries(detection.signals.commands)
          .filter(([, found]) => found)
          .map(([command]) => command);

        const detectedConfigDirs = Object.entries(detection.signals.configDirs)
          .filter(([, exists]) => exists)
          .map(([dir]) => dir);

        const detectedTools = new Set<string>(detectedCommands);
        if (detection.persona.detectedTools.has_claude_cli) {
          detectedTools.add('claude');
          detectedTools.add('claude-cli');
        }
        if (detection.persona.detectedTools.has_ollama) {
          detectedTools.add('ollama');
        }
        if (detection.persona.detectedTools.has_lmstudio) {
          detectedTools.add('lmstudio');
          detectedTools.add('lm-studio');
          detectedTools.add('lms');
        }
        if (detection.persona.detectedTools.has_cursor) {
          detectedTools.add('cursor');
        }
        if (detection.persona.detectedTools.has_vscode) {
          detectedTools.add('vscode');
          detectedTools.add('vs code');
          detectedTools.add('code');
        }

        const results: DetectionResults = {
          bucket: detection.persona.bucket,
          subCategories: detection.persona.subCategories,
          detectedProviders: detection.persona.detectedProviders,
          detectedTools: [...detectedTools],
          isConfident: detection.persona.confident,
          detectedCommands,
          detectedConfigDirs,
          detectedApps: detection.signals.applications,
        };

        setDetectionResults(results);
      } catch (error) {
        console.error('[useEnvironmentDetection] Detection failed:', error);

        // Set fallback results so the flow can continue
        setDetectionResults({
          bucket: 'non-developer',
          subCategories: [],
          detectedProviders: [],
          detectedTools: [],
          isConfident: false,
          detectedCommands: [],
          detectedConfigDirs: [],
          detectedApps: [],
        });
      }
    }

    runDetection();
  }, [setDetectionResults, isDetectionComplete]);

  return {
    isDetectionComplete,
  };
}
