import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VideoViewer } from './VideoViewer';

const mock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getFileUrl: vi.fn(),
  transcribeVoiceWav: vi.fn(),
  captureStarts: 0,
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
    async start() { mock.captureStarts++; }
    stop() {}
  },
}));

describe('VideoViewer timestamped voice notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.captureOptions = null;
    mock.captureStarts = 0;
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

  test('keeps the fractional playhead and blocks a second capture while transcription is pending', async () => {
    let finish!: (text: string) => void;
    mock.transcribeVoiceWav.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const { container } = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    video.currentTime = 12.375;
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    const pending = mock.captureOptions!.onUtterance(new Blob(['first']));
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeDisabled());
    video.currentTime = 28.875;
    fireEvent.click(screen.getByText('Speak a note'));
    expect(mock.captureStarts).toBe(1);
    finish('First delayed caption.');
    await act(async () => { await pending; });
    expect(JSON.parse(mock.writeFile.mock.calls[0]![1] as string).notes[0]).toMatchObject({
      text: 'First delayed caption.', atSeconds: 12.375,
    });
    expect(play).toHaveBeenCalledOnce();
  });

  test('never resumes another video after the original sidecar write completes', async () => {
    let finishWrite!: (result: { success: boolean }) => void;
    mock.writeFile.mockImplementation(() => new Promise(resolve => { finishWrite = resolve; }));
    const view = render(<VideoViewer filePath="/private/old.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = view.container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    video.currentTime = 7.625;
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    const pending = mock.captureOptions!.onUtterance(new Blob(['old']));
    await waitFor(() => expect(mock.writeFile).toHaveBeenCalledOnce());
    expect(mock.writeFile.mock.calls[0]![0]).toBe('/private/old.mp4.review.json');
    view.rerender(<VideoViewer filePath="/private/new.mp4" />);
    await waitFor(() => expect(mock.readFile).toHaveBeenCalledWith('/private/new.mp4.review.json'));
    finishWrite({ success: true });
    await act(async () => { await pending; });
    expect(play).not.toHaveBeenCalled();
    expect(screen.queryByText('The skyline needs attention.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('switching video before delayed transcription resolves cannot write either sidecar', async () => {
    let finish!: (text: string) => void;
    mock.transcribeVoiceWav.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const view = render(<VideoViewer filePath="/private/old.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = view.container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    video.currentTime = 3.125;
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    const pending = mock.captureOptions!.onUtterance(new Blob(['old']));
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeDisabled());
    view.rerender(<VideoViewer filePath="/private/new.mp4" />);
    finish('A late caption from the old video.');
    await act(async () => { await pending; });
    expect(mock.writeFile).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('does not carry a manual draft or old review state across a pending new sidecar read', async () => {
    let finishRead!: (result: { content: string }) => void;
    mock.readFile.mockImplementation((path: string) => path.includes('new.mp4')
      ? new Promise(resolve => { finishRead = resolve; }) : Promise.resolve({ content: JSON.stringify({
        version: 1, notes: [{ id: 'old-1', atSeconds: 2.5, text: 'Old caption.' }],
      }) }));
    const view = render(<VideoViewer filePath="/private/old.mp4" />);
    await waitFor(() => expect(screen.getByText('Old caption.')).toBeInTheDocument());
    fireEvent.change(screen.getByRole('textbox', { name: 'Review note' }), {
      target: { value: 'Old draft.' },
    });
    view.rerender(<VideoViewer filePath="/private/new.mp4" />);
    const submit = screen.getByRole('button', { name: 'Save note' });
    expect(submit).toBeDisabled();
    fireEvent.submit(submit.closest('form')!);
    expect(mock.writeFile).not.toHaveBeenCalled();
    await act(async () => finishRead({ content: JSON.stringify({ version: 1, notes: [] }) }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Speak a note' })).toBeEnabled());
    expect(screen.queryByText('Old caption.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Review note' })).toHaveValue('');
  });

  test('a failed sidecar save does not resume playback or pretend a voice note was stored', async () => {
    mock.writeFile.mockResolvedValue({ success: false, error: 'Could not persist review' });
    const { container } = render(<VideoViewer filePath="/private/review.mp4" />);
    await waitFor(() => expect(screen.getByText('Speak a note')).toBeEnabled());
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(video, 'play').mockResolvedValue();
    fireEvent.click(screen.getByText('Speak a note'));
    act(() => mock.captureOptions!.onSpeechStart());
    await act(async () => mock.captureOptions!.onUtterance(new Blob(['wav'])));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not persist review');
    expect(play).not.toHaveBeenCalled();
    expect(screen.queryByText('The skyline needs attention.')).not.toBeInTheDocument();
  });
});
