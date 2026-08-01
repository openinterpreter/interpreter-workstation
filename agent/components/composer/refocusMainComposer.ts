type FocusableComposerEditor = {
  commands: {
    focus: () => void;
  };
};

type FrameScheduler = (callback: () => void) => unknown;

export function refocusMainComposer(
  editor: FocusableComposerEditor,
  scheduleFrame: FrameScheduler = (callback) => requestAnimationFrame(callback),
): void {
  editor.commands.focus();
  scheduleFrame(() => {
    editor.commands.focus();
    scheduleFrame(() => {
      editor.commands.focus();
    });
  });
}
