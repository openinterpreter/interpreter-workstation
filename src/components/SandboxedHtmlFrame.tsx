import { UNTRUSTED_IFRAME_SANDBOX } from '../utils/untrustedHtml';

interface SandboxedHtmlFrameProps {
  title: string;
  srcDoc: string;
  className?: string;
}

export function SandboxedHtmlFrame({ title, srcDoc, className }: SandboxedHtmlFrameProps) {
  return (
    <iframe
      className={className}
      allow=""
      sandbox={UNTRUSTED_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', border: 'none' }}
      title={title}
    />
  );
}
