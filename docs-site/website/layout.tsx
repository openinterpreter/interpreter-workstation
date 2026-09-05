import type { Metadata } from "next";
import { DocsLayoutShell } from "@/components/docs/docs-layout-shell";
import { createSocialMetadata } from "@/lib/site/social-metadata";

const TITLE = "Desktop documentation | Open Interpreter";
const DESCRIPTION = "Install and use Interpreter Desktop.";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.openinterpreter.com"),
  title: {
    default: TITLE,
    template: "%s | Interpreter Desktop",
  },
  description: DESCRIPTION,
  ...createSocialMetadata({
    title: TITLE,
    description: DESCRIPTION,
    path: "/docs/desktop",
  }),
};

export default function DesktopDocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DocsLayoutShell product="desktop">{children}</DocsLayoutShell>;
}
