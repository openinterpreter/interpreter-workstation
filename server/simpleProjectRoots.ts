import { hostSimpleProjects } from './simpleInterfaceProjects';
import { getSimpleWorkspacePath } from './simpleWorkspace';

/** Never trust a message-supplied path for an additional OIX writable root. */
export async function allowedControlRootForProject(cwd: string): Promise<string[]> {
  const registry = hostSimpleProjects(getSimpleWorkspacePath);
  const registered = (await registry.list()).find(project => project.path === cwd);
  if (!registered || !(await registry.resolve(registered.id))) return [];
  return [await getSimpleWorkspacePath()];
}
