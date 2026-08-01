import { humanizeSkillName } from "./skillDisplay";

export interface SkillMentionToken {
  id: string;
  label: string;
  name: string;
  path: string;
}

export interface ExtractedSkillMentions {
  text: string;
  skills: SkillMentionToken[];
}

const SKILL_TOKEN_REGEX = /skill:\[([^\]]+)\]\(([^)\n]+)\)/g;
const SKILL_ROUND_TRIP_SUFFIX_PREFIX = "\u0000skill:";
const SKILL_ROUND_TRIP_SUFFIX_TERMINATOR = "\u0000";
const SKILL_ROUND_TRIP_PLACEHOLDER_REGEX = /\$([^\s\u0000]+)\u0000skill:([^:\u0000]+):([^\u0000]+)\u0000/g;

function createDefaultSkillId(name: string, path: string): string {
  return `${name}:${path}`;
}

function parsePayload(payload: string): SkillMentionToken | null {
  const params = new URLSearchParams(payload);
  const name = params.get("name")?.trim() ?? "";
  const path = params.get("path")?.trim() ?? "";
  if (!name || !path) {
    return null;
  }

  return {
    id: params.get("id")?.trim() || createDefaultSkillId(name, path),
    label: humanizeSkillName(params.get("label")?.trim() || name),
    name,
    path,
  };
}

function buildPayload(skill: SkillMentionToken): string {
  const params = new URLSearchParams({
    id: skill.id || createDefaultSkillId(skill.name, skill.path),
    label: skill.label,
    name: skill.name,
    path: skill.path,
  });
  return params.toString();
}

function buildRoundTripSuffix(skill: Pick<SkillMentionToken, "id" | "name" | "path">): string {
  const encodedId = encodeURIComponent(skill.id || createDefaultSkillId(skill.name, skill.path));
  const encodedPath = encodeURIComponent(skill.path);
  return `${SKILL_ROUND_TRIP_SUFFIX_PREFIX}${encodedId}:${encodedPath}${SKILL_ROUND_TRIP_SUFFIX_TERMINATOR}`;
}

function buildRoundTripPlaceholder(skill: Pick<SkillMentionToken, "id" | "name" | "path">): string {
  return `$${skill.name}${buildRoundTripSuffix(skill)}`;
}

export function serializeSkillMentionToken(skill: SkillMentionToken): string {
  return `skill:[${skill.label}](${buildPayload(skill)})`;
}

export function parseSkillMentionToken(
  fullMatch: string,
): SkillMentionToken | null {
  const match = /^skill:\[([^\]]+)\]\(([^)\n]+)\)$/.exec(fullMatch.trim());
  if (!match) {
    return null;
  }

  const parsed = parsePayload(match[2]);
  if (!parsed) {
    return null;
  }

  return {
    ...parsed,
    label: humanizeSkillName(match[1] || parsed.label),
  };
}

export function extractSkillMentionsFromText(
  text: string,
): ExtractedSkillMentions {
  SKILL_TOKEN_REGEX.lastIndex = 0;

  const skills: SkillMentionToken[] = [];
  const seen = new Set<string>();
  let cleaned = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SKILL_TOKEN_REGEX.exec(text)) !== null) {
    cleaned += text.slice(lastIndex, match.index);

    const parsed = parsePayload(match[2]);
    if (parsed) {
      const key = `${parsed.name}\u0000${parsed.path}`;
      if (!seen.has(key)) {
        skills.push({
          ...parsed,
          label: humanizeSkillName(match[1] || parsed.label),
        });
        seen.add(key);
      }
      cleaned += buildRoundTripPlaceholder(parsed);
    } else {
      cleaned += match[0];
    }

    lastIndex = match.index + match[0].length;
  }

  cleaned += text.slice(lastIndex);

  return {
    text: cleaned.trim(),
    skills,
  };
}

export function injectSkillMentionsIntoText(
  text: string,
  skills: Array<Pick<SkillMentionToken, "id" | "label" | "name" | "path">>,
): string {
  const skillsById = new Map<string, Pick<SkillMentionToken, "id" | "label" | "name" | "path">>();
  const skillsByNameAndPath = new Map<string, Pick<SkillMentionToken, "id" | "label" | "name" | "path">>();

  for (const skill of skills) {
    const skillId = skill.id || createDefaultSkillId(skill.name, skill.path);
    skillsById.set(skillId, skill);
    skillsByNameAndPath.set(`${skill.name}\u0000${skill.path}`, skill);
  }

  const matchedSkillKeys = new Set<string>();
  SKILL_ROUND_TRIP_PLACEHOLDER_REGEX.lastIndex = 0;
  const nextText = text.replace(
    SKILL_ROUND_TRIP_PLACEHOLDER_REGEX,
    (_fullMatch, placeholderName: string, encodedId: string, encodedPath: string) => {
      let decodedId = encodedId;
      let decodedPath = encodedPath;
      try {
        decodedId = decodeURIComponent(encodedId);
        decodedPath = decodeURIComponent(encodedPath);
      } catch {
        // Keep the encoded form if the placeholder is malformed.
      }

      const matchedSkillById = skillsById.get(decodedId);
      const matchedSkill = matchedSkillById
        ?? skillsByNameAndPath.get(`${placeholderName}\u0000${decodedPath}`);

      if (matchedSkill) {
        matchedSkillKeys.add(`${matchedSkill.name}\u0000${matchedSkill.path}`);
      }

      const resolvedName = matchedSkill?.name || placeholderName;
      const resolvedPath = matchedSkill?.path || decodedPath;
      const resolvedId = matchedSkillById?.id
        || decodedId
        || matchedSkill?.id
        || createDefaultSkillId(resolvedName, resolvedPath);
      const resolvedLabel = humanizeSkillName(matchedSkill?.label || resolvedName);

      return serializeSkillMentionToken({
        id: resolvedId,
        label: resolvedLabel,
        name: resolvedName,
        path: resolvedPath,
      });
    },
  );

  const missingTokens = skills
    .filter((skill) => !matchedSkillKeys.has(`${skill.name}\u0000${skill.path}`))
    .map((skill) => serializeSkillMentionToken({
      id: skill.id || createDefaultSkillId(skill.name, skill.path),
      label: humanizeSkillName(skill.label || skill.name),
      name: skill.name,
      path: skill.path,
    }));

  if (missingTokens.length === 0) {
    return nextText;
  }

  const prefix = missingTokens.join(" ");
  return nextText.trim().length > 0 ? `${prefix} ${nextText}` : prefix;
}

export function replaceSkillMentionsWithLabels(text: string): string {
  SKILL_TOKEN_REGEX.lastIndex = 0;

  return text.replace(SKILL_TOKEN_REGEX, (fullMatch, label, payload) => {
    const parsed = parsePayload(payload);
    if (!parsed) {
      return fullMatch;
    }
    return humanizeSkillName(label || parsed.label || parsed.name);
  });
}
