import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VideoViewer } from './VideoViewer';

const mock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getFileUrl: vi.fn(),
  transcribeVoiceWav: vi.fn(),
  captureOptions: null as null | {
    onSpeechStart: () => void;
    onUtterance: (blob: Blob) => Promise<void>;
  },
}));

vi.mock('@/ipc', () => ({ getFileUrl: mock.getFileUrl }));
vi.mock('../api', () => ({ readFile: mock.readFile, writeFile: mock.writeFile }));
vi.mock('../remote/workstationConnection', () => ({ isWorkstationReadOnly: () => false }));
vi.mock('../utils/feedback', () => ({ openFeedbackPopover: vi.fn() }));
vi.mock('../hooks/useFileRefresh', () => ({ useFileRefresh: vi.fn() }));
vi.mock('../../agent/utils/voiceCapture', () => ({
  transcribeVoiceWav: mock.transcribeVoiceWav,
  VoiceCaptureSession: class {
    constructor(options: typeof mock.captureOptions) { mock.captureOptions = options; }
    async start() {}
    stop() {}
  },
}));

describe('VideoViewer timestamped voice notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.captureOptions = null;
    mock.getFileUrl.mockResolvedValue('blob:video');
    mock.readFile.mockRejectedValue(new Error('ENOENT'));
    mock.writeFile.mockResolvedValue({ success: true });
    mock.transcribeVoiceWav.mockResolvedValue('The skyline needs attention.');
  });

  test('pauses on speech, records exact playhead in a separate sidecar, resumes and seeks to the note', async () => {
    const { container } = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    video.currentTime = 12.375;
    fireEvent.click(screen.getByText('Speak a note'));
    await waitFor(() => expect(mock.captureOptions).not.toBeNull());
    act(() => mock.captureOptions!.onSpeechStart());
    expect(pause).toHaveBeenCalledOnce();
    video.currentTime = 18;
    await act(async () => mock.captureOptions!.onUtterance(new Blob(['wav'])));
    expect(mock.writeFile).toHaveBeenCalledOnce();
    const [path, contents] = mock.writeFile.mock.calls[0] as [string, string];
    expect(path).toBe('/private/review.mp4.review.json');
    expect(JSON.parse(contents).notes[0]).toMatchObject({ atSeconds: 12.375, text: 'The skyline needs attention.' });
    expect(play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '00:00:12' }));
    expect(video.currentTime).toBe(12.375);
  });

  test('does not overwrite a malformed existing review sidecar', async () => {
    mock.readFile.mockResolvedValue({ content: '{"version":2,"notes":[]}' });
    render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Speak a note' })).toBeDisabled();
    expect(mock.writeFile).not.toHaveBeenCalled();
  });
});
