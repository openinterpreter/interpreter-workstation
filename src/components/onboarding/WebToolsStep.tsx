/**
 * WebToolsStep Component
 *
 * Onboarding step: Configure web tools that require internet connection.
 * Shown only to users who chose "Keep everything private" in the privacy step.
 */

import { useState } from 'react';
import { ChevronLeft, Globe, Info } from 'lucide-react';
import { Checkbox } from '../ui/checkbox';

interface WebToolsStepProps {
  onComplete: (webSearchEnabled: boolean) => void | Promise<void>;
  onBack: () => void;
}

export function WebToolsStep({ onComplete, onBack }: WebToolsStepProps) {
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const handleContinue = async () => {
    setIsSubmitting(true);
    try {
      await onComplete(webSearchEnabled);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full px-8 py-12">
      <div className="max-w-md w-full space-y-8">
        {/* Back button */}
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-ui-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="size-4" />
          Back
        </button>

        {/* Header */}
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-normal leading-[1.1] text-foreground">
            Web Tools
          </h1>
          <p className="text-base text-muted-foreground">
            Some tools require an internet connection and route queries through our servers.
          </p>
        </div>

        {/* Web Search Toggle */}
        <div className="space-y-3">
          <label
            className="w-full flex items-start gap-3 p-3 rounded-control transition-all hover:bg-hover cursor-default"
            style={{ border: 'var(--border-width) solid var(--border)' }}
          >
            <div className="mt-0.5">
              <Checkbox
                checked={webSearchEnabled}
                onCheckedChange={(checked) => setWebSearchEnabled(checked === true)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Globe className="size-4 text-muted-foreground" />
                <span className="text-ui-sm text-foreground font-medium">Web Search</span>
              </div>
              <p className="text-ui-xs text-muted-foreground">
                Search the web, visit websites, and run code. Powered by our Web Agent.
              </p>
            </div>
          </label>
        </div>

        {/* Privacy disclosure */}
        <div className="space-y-3">
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-ui-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 mx-auto"
          >
            <Info className="size-3" />
            How does this work?
          </button>

          {showDetails && (
            <div className="p-3 rounded-control bg-muted/50 text-ui-xs space-y-2">
              <p className="text-muted-foreground">
                Web search queries are sent through our API to perform searches and fetch web pages. We process the results and return them to your agent.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">What we log:</strong> Search queries are logged for 30 days to prevent abuse.
              </p>
              <p className="text-muted-foreground">
                <strong className="text-foreground">What we don't store:</strong> Search results, web page contents, and your agent's analysis are not stored.
              </p>
            </div>
          )}
        </div>

        {/* Help text */}
        <p className="text-ui-xs text-muted-foreground text-center">
          You can change this anytime in Settings
        </p>

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={isSubmitting}
          className="w-full py-2 rounded-control bg-foreground text-background text-ui-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
