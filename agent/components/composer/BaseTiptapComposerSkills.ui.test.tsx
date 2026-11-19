import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { BaseTiptapComposer } from './BaseTiptapComposer';
import { getSkillItemById, setSkillItemRegistry } from './mention/skillMentionSuggestion';
import { IpcUnavailableError } from '../../../shared/ipcAvailability';

const skillsIpc = vi.hoisted(() => ({ list: vi.fn(), onChanged: vi.fn() }));

vi.mock('@/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ipc')>()),
  skills: skillsIpc,
}));

vi.mock('../../../src/hooks/useLayout', () => {
  const layout = { state: { tabs: {} } };
  const actions = { openFile: () => {}, openFolder: () => {}, openBrowser: () => {} };
  return { useLayout: () => layout, useLayoutActions: () => actions };
});

vi.mock('@/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const LOAD_FAILURE = '[BaseTiptapComposer] Failed to load skills:';

function loadFailureLogs(consoleError: { mock: { calls: unknown[][] } }) {
  return consoleError.mock.calls.filter(([message]) => message === LOAD_FAILURE);
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('BaseTiptapComposer skill list', () => {
  beforeEach(() => {
    setSkillItemRegistry([]);
    skillsIpc.onChanged.mockReturnValue(() => {});
  });

  test('loads skills for the slash-command list', async () => {
    skillsIpc.list.mockResolvedValue({
      success: true,
      data: {
        project: { rootPath: '/workspace/.skills', skills: [] },
        global: {
          rootPath: '/skills',
          skills: [{
            id: 'imagegen',
            name: 'imagegen',
            title: 'Imagegen',
            filePath: '/skills/imagegen/SKILL.md',
            description: 'Generate images',
            source: 'global',
          }],
        },
      },
    });
    render(<BaseTiptapComposer isMainComposer onSend={() => {}} />);
    await waitFor(() => expect(getSkillItemById('imagegen')).toMatchObject({ name: 'imagegen' }));
  });

  test('a host without skills leaves the list empty without logging an error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    skillsIpc.list.mockRejectedValue(new IpcUnavailableError('skills.list'));
    render(<BaseTiptapComposer isMainComposer onSend={() => {}} />);
    await waitFor(() => expect(skillsIpc.list).toHaveBeenCalledWith({ workspacePath: null }));
    await settle();
    expect(loadFailureLogs(consoleError)).toEqual([]);
    expect(getSkillItemById('imagegen')).toBeUndefined();
  });

  test('a real failure to load skills is still logged', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Could not read skills folder');
    skillsIpc.list.mockRejectedValue(failure);
    render(<BaseTiptapComposer isMainComposer onSend={() => {}} />);
    await waitFor(() => expect(loadFailureLogs(consoleError)).toEqual([[LOAD_FAILURE, failure]]));
  });
});
