export type SkillSource = 'project' | 'global';

export interface SkillTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: SkillTreeNode[];
}

export interface SkillOption {
  id: string;
  name: string;
  title: string;
  description: string;
  source: SkillSource;
  scope: 'user' | 'repo' | 'system' | 'admin';
  dirPath: string;
  filePath: string;
  enabled: boolean;
}

export interface SkillsData {
  global: {
    rootPath: string;
    skills: SkillOption[];
    tree: SkillTreeNode[];
  };
  project: {
    rootPath: string | null;
    skills: SkillOption[];
    tree: SkillTreeNode[];
  };
}

export interface SkillsListRequest {
  workspacePath?: string | null;
}
