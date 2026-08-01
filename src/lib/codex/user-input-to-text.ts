import type { v2 } from "../../../server/handlers/codex-generated-types/index";
import { injectSkillMentionsIntoText } from "../../../shared/utils/skillMentions";
import { humanizeSkillName } from "../../../shared/utils/skillDisplay";

export function userInputToText(content: v2.UserInput[]): string {
  const text = content
    .filter((input): input is Extract<v2.UserInput, { type: "text" }> => input.type === "text")
    .map((input) => input.text)
    .join("\n");
  const skills = content
    .filter((input): input is Extract<v2.UserInput, { type: "skill" }> => input.type === "skill")
    .map((input) => ({
      id: `${input.name}:${input.path}`,
      label: humanizeSkillName(input.name),
      name: input.name,
      path: input.path,
    }));

  return injectSkillMentionsIntoText(text, skills);
}
