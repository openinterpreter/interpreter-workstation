import { tr, type LocaleKey } from "@/i18n";

import type { TurnErrorDescriptor } from "./errors";

export function translateTurnError(descriptor: TurnErrorDescriptor): string {
  if (descriptor.kind === "raw") {
    return descriptor.text;
  }

  if (descriptor.kind === "sequence") {
    return descriptor.parts
      .map((part) => translateTurnError(part))
      .join(descriptor.separator ?? "");
  }

  return tr(descriptor.key as LocaleKey, descriptor.params);
}
