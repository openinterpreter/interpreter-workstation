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

  test('loads a persisted fractional-time transcript after remount and seeks without changing the video', async () => {
    const persisted = { version: 1, notes: [{ id: 'saved-1', atSeconds: 4.625, text: 'A saved observation.' }] };
    mock.readFile.mockResolvedValue({ content: JSON.stringify(persisted) });
    const first = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('A saved observation.')).toBeInTheDocument());
    first.unmount();
    const second = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('A saved observation.')).toBeInTheDocument());
    const video = second.container.querySelector('video')!;
    fireEvent.click(screen.getByRole('button', { name: '00:00:04' }));
    expect(video.currentTime).toBe(4.625);
    expect(mock.writeFile).not.toHaveBeenCalled();
    expect(mock.readFile).toHaveBeenCalledWith('/private/review.mp4.review.json');
  });

  test('does not resume a previously paused video after speech transcription', async () => {
    const { container } = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: true });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    video.currentTime = 9.875;
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    await act(async () => mock.captureOptions!.onUtterance(new Blob(['wav'])));
    expect(play).not.toHaveBeenCalled();
    expect(JSON.parse(mock.writeFile.mock.calls[0]![1] as string).notes[0].atSeconds).toBe(9.875);
  });

  test('surfaces transcription errors without writing notes or resuming playback', async () => {
    mock.transcribeVoiceWav.mockRejectedValue(new Error('Speech runtime unavailable'));
    const { container } = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    await act(async () => mock.captureOptions!.onUtterance(new Blob(['wav'])));
    expect(screen.getByRole('alert')).toHaveTextContent('Speech runtime unavailable');
    expect(mock.writeFile).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
  });
});
