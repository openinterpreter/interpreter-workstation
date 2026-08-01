const FIREWALL_SETUP_ERROR_PATTERNS = [
  /helper_firewall_(?:policy_access_failed|rule_create_or_add_failed|rule_verify_failed)/i,
  /SetRemoteAddresses failed/i,
  /HRESULT\(0x80070057\)/i,
];

const DEFAULT_SETUP_ERROR_MESSAGE =
  'Windows sandbox setup failed. Retry from the Windows sandbox setup card.';
const FIREWALL_SETUP_ERROR_MESSAGE =
  'Windows sandbox setup could not configure Windows Firewall. Check firewall policy, then retry from the Windows sandbox setup card.';

export function isWindowsSandboxFirewallSetupError(error: string): boolean {
  return FIREWALL_SETUP_ERROR_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatWindowsSandboxSetupError(rawError: string | null | undefined): string {
  const trimmedError = rawError?.trim();
  if (!trimmedError) {
    return DEFAULT_SETUP_ERROR_MESSAGE;
  }

  if (isWindowsSandboxFirewallSetupError(trimmedError)) {
    return FIREWALL_SETUP_ERROR_MESSAGE;
  }

  return trimmedError;
}
