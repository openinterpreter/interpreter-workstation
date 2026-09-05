import { useState, useEffect } from 'react';
import { ECHO_SECRET_INPUT_ID, ECHO_SECRET_TEST_BUTTON_ID, ECHO_SECRET_SAVE_BUTTON_ID, ECHO_SECRET_LAST_RESULT_ID } from '../../../shared/element-ids';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { getAppServerOrigin } from '@/ipc';
import { callTool } from '@/api';

interface EchoSecretUIProps {
  serverId: string;
}

interface EchoSecretSettings {
  defaultMessage: string;
  lastResult: string | null;
}

export function EchoSecretUI({ serverId }: EchoSecretUIProps) {
  const [settings, setSettings] = useState<EchoSecretSettings>({
    defaultMessage: 'test-secret',
    lastResult: null,
  });
  const [secretInput, setSecretInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    setSecretInput(settings.defaultMessage);
  }, [settings.defaultMessage]);

  async function loadSettings() {
    try {
      const origin = await getAppServerOrigin();
      const response = await fetch(`${origin}/api/tool-settings/${serverId}`, { credentials: 'include' });

      if (response.ok) {
        const data = await response.json();
        setSettings(data);
      }
    } catch (error) {
      // Settings don't exist yet, use defaults
      console.log('Using default settings for echo-secret');
    }
  }

  async function saveSettings(newSettings: EchoSecretSettings) {
    try {
      const origin = await getAppServerOrigin();
      await fetch(`${origin}/api/tool-settings/${serverId}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      });
      setSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
    }
  }

  async function handleTest() {
    try {
      setTesting(true);
      setMessage(null);

      const result = await callTool(serverId, 'echo_secret', { secret: secretInput });

      // Fail fast if response doesn't match expected structure
      if (!result.content || !result.content[0] || !result.content[0].text) {
        throw new Error('Invalid tool response format');
      }

      const resultText = result.content[0].text;

      const newSettings = { ...settings, lastResult: resultText };
      await saveSettings(newSettings);

      setMessage({ type: 'success', text: 'Tool executed successfully!' });
    } catch (error: any) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveDefault() {
    const newSettings = { ...settings, defaultMessage: secretInput };
    await saveSettings(newSettings);
    setMessage({ type: 'success', text: 'Default message saved!' });
  }

  const messageToneStyle = message?.type === 'success'
    ? {
        border: 'var(--border-width) solid color-mix(in srgb, rgb(34 197 94) 28%, transparent)',
        background: 'color-mix(in srgb, rgb(34 197 94) 10%, transparent)',
      }
    : {
        border: 'var(--border-width) solid color-mix(in srgb, rgb(239 68 68) 24%, transparent)',
        background: 'color-mix(in srgb, rgb(239 68 68) 8%, transparent)',
      };

  return (
    <div
      className="mt-4 pt-4"
      style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)' }}
    >
      <div className="space-y-4">
        <div className="space-y-1">
          <h4 className="text-ui-sm font-medium text-foreground">Echo Secret Configuration</h4>
          <p className="max-w-2xl text-ui-sm leading-6 text-muted-foreground">
            Test the tool with a secret message and optionally save that value as the default for future runs.
          </p>
        </div>

        {message && (
          <div
            className="rounded-[14px] px-3 py-2 text-ui-sm"
            style={messageToneStyle}
          >
            {message.text}
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-ui-sm font-medium text-foreground">
            Secret Message
          </Label>
          <Input
            type="text"
            value={secretInput}
            onChange={(e) => setSecretInput(e.target.value)}
            placeholder="Enter a secret message"
            data-testid={ECHO_SECRET_INPUT_ID}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={handleTest}
            disabled={testing || !secretInput}
            variant="default"
            size="sm"
            data-testid={ECHO_SECRET_TEST_BUTTON_ID}
          >
            {testing ? 'Testing...' : 'Test Tool'}
          </Button>
          <Button
            onClick={handleSaveDefault}
            disabled={testing || !secretInput}
            variant="outline"
            size="sm"
            data-testid={ECHO_SECRET_SAVE_BUTTON_ID}
          >
            Save as Default
          </Button>
        </div>

        {settings.lastResult && (
          <div
            className="space-y-2 pt-4"
            style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 40%, transparent)' }}
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Last result</p>
            <p
              className="rounded-[14px] px-3 py-2 text-ui-sm leading-6 text-foreground"
              style={{
                border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 42%, transparent)',
                background: 'color-mix(in srgb, var(--oa-bg-subtle, var(--muted)) 72%, transparent)',
              }}
              data-testid={ECHO_SECRET_LAST_RESULT_ID}
            >
              {settings.lastResult}
            </p>
          </div>
        )}

        <div
          className="pt-4"
          style={{ borderTop: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 40%, transparent)' }}
        >
          <p className="text-ui-sm leading-6 text-muted-foreground">
            <strong>Current default:</strong> {settings.defaultMessage}
          </p>
        </div>
      </div>
    </div>
  );
}
