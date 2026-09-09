export interface PiiDetection {
  category: string;
  start: number;
  end: number;
  text: string;
  confidence: number;
}

export function detectRegex(text: string): PiiDetection[] {
  const detections: PiiDetection[] = [];

  // Email pattern
  const emailRegex = /[\w.+-]+@[\w-]+\.[\w.]+/g;
  let match: RegExpExecArray | null;
  while ((match = emailRegex.exec(text)) !== null) {
    const m = match; // help TS narrow the type
    detections.push({
      category: 'email',
      start: m.index,
      end: m.index + m[0].length,
      text: m[0],
      confidence: 1.0,
    });
    emailRegex.lastIndex = m.index + 1;
  }

  // Phone pattern
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  while ((match = phoneRegex.exec(text)) !== null) {
    const m = match;
    const alreadyCovered = detections.some(d => d.start <= m.index && m.index + m[0].length <= d.end);
    if (!alreadyCovered) {
      detections.push({
        category: 'phone',
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        confidence: 1.0,
      });
    }
    phoneRegex.lastIndex = m.index + 1;
  }

  // IPv4 pattern
  const ipv4Regex = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
  while ((match = ipv4Regex.exec(text)) !== null) {
    const m = match;
    const alreadyCovered = detections.some(d => d.start <= m.index && m.index + m[0].length <= d.end);
    if (!alreadyCovered) {
      detections.push({
        category: 'ipv4',
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        confidence: 1.0,
      });
    }
    ipv4Regex.lastIndex = m.index + 1;
  }

  // Credit card pattern
  const ccRegex = /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g;
  while ((match = ccRegex.exec(text)) !== null) {
    const m = match;
    const alreadyCovered = detections.some(d => d.start <= m.index && m.index + m[0].length <= d.end);
    if (!alreadyCovered) {
      detections.push({
        category: 'credit_card',
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        confidence: 1.0,
      });
    }
    ccRegex.lastIndex = m.index + 1;
  }

  // Sort by start position
  detections.sort((a, b) => a.start - b.start);

  // Merge overlapping/adjacent detections
  const merged: PiiDetection[] = [];
  for (const d of detections) {
    const last = merged[merged.length - 1];
    if (last && last.end >= d.start - 1) {
      merged[merged.length - 1] = {
        category: last.category,
        start: last.start,
        end: Math.max(last.end, d.end),
        text: text.substring(last.start, Math.max(last.end, d.end)),
        confidence: 1.0,
      };
    } else {
      merged.push(d);
    }
  }

  return merged;
}