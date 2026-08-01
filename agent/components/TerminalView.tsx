/**
 * TerminalView - xterm.js based terminal component
 *
 * Uses xterm.js with WebGL/Canvas addon for GPU acceleration.
 * Connects to a backend PTY session via IPC.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import './TerminalView.css';
import { terminal, showContextMenu, type ContextMenuItem } from '@/ipc';
import { TERMINAL_VIEW_ID } from '../../shared/element-ids';

// Terminal input mode is now dynamic (state-based, toggled via context menu)

// Prompt hint overlay - shows "Hold ⌘L to Dictate" at cursor position
// Currently unused but kept for potential future dictation feature
interface PromptPosition {
  row: number;
  col: number;
}

// function PromptHintOverlay({ position, cellWidth, cellHeight }: {
//   position: PromptPosition | null;
//   cellWidth: number;
//   cellHeight: number;
// }) {
//   if (!position) return null;
//
//   const hintText = 'Hold ⌘L to Dictate';
//   const startCol = position.col + 2; // +2 to skip "❯ "
//   const hPadding = 4;
//
//   return (
//     <div
//       style={{
//         position: 'absolute',
//         top: position.row * cellHeight,
//         left: startCol * cellWidth - hPadding, // offset by padding so text stays on grid
//         height: cellHeight,
//         zIndex: 10,
//         pointerEvents: 'none',
//         display: 'flex',
//         alignItems: 'center',
//         background: 'var(--background)',
//         border: 'var(--border-width) solid var(--border)',
//         borderRadius: 'var(--control-radius)',
//         boxShadow: 'var(--shadow-color) 0px 1px 3px',
//         paddingLeft: hPadding,
//         paddingRight: hPadding,
//       }}
//     >
//       {hintText.split('').map((char, i) => (
//         <div
//           key={i}
//           style={{
//             width: cellWidth,
//             display: 'flex',
//             alignItems: 'center',
//             justifyContent: 'center',
//             fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
//             fontSize: '13px',
//             color: 'var(--muted-foreground)',
//           }}
//         >
//           {char}
//         </div>
//       ))}
//     </div>
//   );
// }

// Animated terminal line component - currently unused but kept for potential future use
// function AnimatedTerminalLine({ cellCount }: { cellCount: number }) {
//   const [activeCells, setActiveCells] = useState<boolean[]>([]);
//
//   // Initialize and animate cells
//   useEffect(() => {
//     const cells = new Array(cellCount).fill(false);
//     setActiveCells(cells);
//
//     // Animate random cells turning on/off
//     const interval = setInterval(() => {
//       setActiveCells(prev => {
//         const next = [...prev];
//         // Turn off some cells
//         for (let i = 0; i < 3; i++) {
//           const idx = Math.floor(Math.random() * cellCount);
//           next[idx] = false;
//         }
//         // Turn on some cells
//         for (let i = 0; i < 3; i++) {
//           const idx = Math.floor(Math.random() * cellCount);
//           next[idx] = true;
//         }
//         return next;
//       });
//     }, 80);
//
//     return () => clearInterval(interval);
//   }, [cellCount]);
//
//   return (
//     <div
//       className="flex items-center"
//       style={{
//         fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
//         fontSize: '13px',
//         lineHeight: '1.2',
//         height: `${13 * 1.2}px`,
//       }}
//     >
//       {activeCells.map((active, i) => (
//         <span
//           key={i}
//           style={{
//             display: 'inline-block',
//             width: '0.6em',
//             height: '1em',
//             backgroundColor: active ? 'var(--primary)' : 'transparent',
//             transition: 'background-color 0.05s ease',
//           }}
//         />
//       ))}
//     </div>
//   );
// }

// Theme configurations - transparent background
const DARK_THEME = {
  background: '#00000000',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#dcdcaa',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#dcdcaa',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#00000000',
  foreground: '#383a42',
  cursor: '#383a42',
  cursorAccent: '#ffffff',
  selectionBackground: '#bfceff',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#a0a1a7',
  brightBlack: '#4f525e',
  brightRed: '#e45649',
  brightGreen: '#50a14f',
  brightYellow: '#c18401',
  brightBlue: '#4078f2',
  brightMagenta: '#a626a4',
  brightCyan: '#0184bc',
  brightWhite: '#383a42',
};

import { TERMINAL_AGENTS, type TerminalAgentId } from '../../shared/terminalAgents';

// Terminal profiles currently launch the raw CLI command only.
// Keep the old MCP injection path commented near launch so it can be restored later.

interface TerminalViewProps {
  tabId: string;
  isVisible: boolean;
  cwd?: string;
  terminalAgent?: string; // Terminal agent ID (e.g., 'claude-code', 'codex', or custom)
  command?: string; // Command to run (for custom terminals, otherwise looked up from TERMINAL_AGENTS)
  profileId?: string; // Profile ID for MCP endpoint filtering
  // Terminal config options (from profile)
  richInput?: boolean; // If true, show rich text composer; if false, use terminal directly
  hideInput?: boolean; // If true (and richInput), hide the terminal input prompt area
  inputMarker?: string; // Character to detect input prompt for hiding (default: '❯')
  titleMarker?: string; // Character to detect assistant response for tab title
  onClose?: () => void;
  onTitleChange?: (title: string) => void;
}

export function TerminalView({ tabId, isVisible, cwd, terminalAgent = 'claude-code', command, profileId, richInput = false, hideInput = true, inputMarker, titleMarker: titleMarkerProp, onClose, onTitleChange }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [_isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outputBufferRef = useRef<string>('');
  const [_terminalCols, setTerminalCols] = useState(80);
  const [_promptRow, setPromptRow] = useState<number | null>(null);
  const [_terminalRows, setTerminalRows] = useState(24);
  const [cellDimensions, setCellDimensions] = useState({ width: 7.8, height: 15.6 });
  const [_promptPosition, setPromptPosition] = useState<PromptPosition | null>(null);
  const [isReady, setIsReady] = useState(false); // Controls fade-in animation
  const [richInputEnabled, setRichInputEnabled] = useState(richInput); // Initialize from prop, can toggle via right-click

  // Sync richInputEnabled state when richInput prop changes (e.g., from profile settings)
  useEffect(() => {
    setRichInputEnabled(richInput);
  }, [richInput]);

  const isDarkMode = () => document.documentElement.classList.contains('dark');

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const darkMode = isDarkMode();

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      letterSpacing: 0,
      lineHeight: 1.2,
      theme: darkMode ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);

    // Force transparency
    const xtermElement = containerRef.current.querySelector('.xterm') as HTMLElement;
    if (xtermElement) xtermElement.style.background = 'transparent';
    const xtermViewport = containerRef.current.querySelector('.xterm-viewport') as HTMLElement;
    if (xtermViewport) xtermViewport.style.background = 'transparent';
    const xtermScreen = containerRef.current.querySelector('.xterm-screen') as HTMLElement;
    if (xtermScreen) xtermScreen.style.background = 'transparent';

    // Load renderer
    try {
      const webglAddon = new WebglAddon();
      term.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
        term.loadAddon(new CanvasAddon());
      });
    } catch {
      term.loadAddon(new CanvasAddon());
    }

    // Fit to container
    fitAddon.fit();
    setTerminalCols(term.cols);

    // Calculate actual cell dimensions from rendered terminal
    const updateCellDimensions = () => {
      const screen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement;
      if (screen && term.rows > 0 && term.cols > 0) {
        const rect = screen.getBoundingClientRect();
        setCellDimensions({
          width: rect.width / term.cols,
          height: rect.height / term.rows,
        });
      }
    };
    requestAnimationFrame(updateCellDimensions);

    // Show scrollbar only when scrolling
    let scrollTimeout: NodeJS.Timeout | null = null;
    const scrollDisposable = term.onScroll(() => {
      xtermElement?.classList.add('is-scrolling');
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        xtermElement?.classList.remove('is-scrolling');
      }, 1000); // Hide after 1s of no scrolling
    });

    terminalRef.current = term;

    // Create PTY session
    const initSession = async () => {
      try {
        const result = await terminal.create(cwd);
        sessionIdRef.current = result.sessionId;
        setIsConnected(true);

        // Resize PTY to match terminal
        await terminal.resize(result.sessionId, term.cols, term.rows);

        // Wait for shell prompt before sending agent command
        const sendAgentCommand = async () => {
          if (!sessionIdRef.current) return;
          // Check if this is a known agent, otherwise use the command prop
          const isKnownAgent = terminalAgent in TERMINAL_AGENTS;
          const agentConfig = isKnownAgent ? TERMINAL_AGENTS[terminalAgent as TerminalAgentId] : null;
          const agentCommand = command || agentConfig?.command || terminalAgent;
          const fullCommand = agentCommand;
          // const mcpArgs = agentConfig?.getMcpArgs?.(...);
          // const fullCommand = mcpArgs ? `${agentCommand} ${mcpArgs}` : agentCommand;

          // Launch the configured CLI as-is.
          await terminal.write(sessionIdRef.current, `${fullCommand}\n`);
          // Trigger fade-in animation after command is sent
          setTimeout(() => setIsReady(true), 100);
        };

        // Listen for data events to detect prompt, with 1 second timeout
        let promptDetected = false;
        const unsubscribePromptWatch = terminal.onData((event: { sessionId: string; data: string }) => {
          if (promptDetected || event.sessionId !== result.sessionId) return;
          // Check if data contains a prompt character
          if (event.data.includes('❯') || event.data.includes('$') || event.data.includes('%')) {
            promptDetected = true;
            unsubscribePromptWatch();
            sendAgentCommand();
          }
        });

        // Timeout after 1 second - send anyway
        setTimeout(() => {
          if (!promptDetected) {
            promptDetected = true;
            unsubscribePromptWatch();
            sendAgentCommand();
          }
        }, 1000);
      } catch (e: any) {
        console.error('[Terminal] Failed to create session:', e);
        setError(e.message || 'Failed to create terminal session');
      }
    };

    initSession();

    // Handle user input
    const inputDisposable = term.onData(async (data: string) => {
      if (sessionIdRef.current) {
        await terminal.write(sessionIdRef.current, data);
      }
    });

    return () => {
      inputDisposable.dispose();
      scrollDisposable.dispose();
      if (scrollTimeout) clearTimeout(scrollTimeout);

      if (sessionIdRef.current) {
        terminal.close(sessionIdRef.current).catch(console.warn);
        sessionIdRef.current = null;
      }

      // Clear refs before disposing to prevent callbacks from accessing disposed terminal
      terminalRef.current = null;
      fitAddonRef.current = null;

      // Dispose terminal with error handling (xterm can throw during addon cleanup)
      try {
        term.dispose();
      } catch (err) {
        console.warn('[Terminal] Error during dispose:', err);
      }
    };
  }, [cwd, terminalAgent, profileId]);

  // Find last prompt row in terminal buffer - sets position for hint overlay, clips in controlled mode
  const findPromptAndClip = useCallback(() => {
    if (!terminalRef.current || !containerRef.current) return;

    const term = terminalRef.current;
    // Safety check - ensure terminal buffer is accessible
    if (!term.buffer?.active) return;

    const buffer = term.buffer.active;
    const totalRows = term.rows;
    const baseY = buffer.baseY;

    setTerminalRows(totalRows);

    // Determine the input marker to look for (default: ❯)
    const marker = inputMarker || '❯';

    // Determine if we should clip (richInputEnabled AND hideInput)
    const shouldClip = richInputEnabled && (hideInput !== false);

    // Scan from bottom to top for the last input marker
    for (let viewportRow = totalRows - 1; viewportRow >= 0; viewportRow--) {
      const bufferLine = buffer.getLine(baseY + viewportRow);
      if (!bufferLine) continue;

      const lineText = bufferLine.translateToString(true);
      const promptIndex = lineText.lastIndexOf(marker);

      if (promptIndex !== -1) {
        setPromptRow(viewportRow);
        // Set position for hint overlay
        setPromptPosition({ row: viewportRow, col: promptIndex });

        // In controlled mode, clip the terminal to hide prompt (if hideInput is enabled)
        if (shouldClip) {
          const xtermScreen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement;
          if (xtermScreen) {
            const clipFromBottom = (totalRows - viewportRow + 1) * cellDimensions.height;
            xtermScreen.style.clipPath = `inset(0 0 ${clipFromBottom}px 0)`;
          }
        }
        return;
      }
    }

    // No prompt found
    setPromptRow(null);
    setPromptPosition(null);
    if (shouldClip) {
      const xtermScreen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement;
      if (xtermScreen) {
        xtermScreen.style.clipPath = '';
      }
    }
  }, [cellDimensions.height, inputMarker, hideInput, richInputEnabled]);

  // Extract title
  const extractTitle = useCallback((data: string) => {
    outputBufferRef.current += data;
    if (outputBufferRef.current.length > 2000) {
      outputBufferRef.current = outputBufferRef.current.slice(-2000);
    }

    // Use prop titleMarker, or fall back to known agent config
    const isKnownAgent = terminalAgent in TERMINAL_AGENTS;
    const agentConfig = isKnownAgent ? TERMINAL_AGENTS[terminalAgent as TerminalAgentId] : null;
    const titleMarker = titleMarkerProp || agentConfig?.titleMarker;
    if (!titleMarker) return; // No title marker configured
    const lastMarkerIndex = outputBufferRef.current.lastIndexOf(titleMarker);
    if (lastMarkerIndex === -1) return;

    const afterMarker = outputBufferRef.current.slice(lastMarkerIndex + titleMarker.length);
    const newlineIndex = afterMarker.search(/[\r\n]/);
    const title = newlineIndex === -1 ? afterMarker : afterMarker.slice(0, newlineIndex);

    // Debug: log raw bytes to see what escape sequences are present
    const hexDump = [...title].map(c => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 ? `\\x${code.toString(16).padStart(2, '0')}` : c;
    }).join('');
    console.log('[Terminal Title] Raw:', hexDump);

    const cleanTitle = title
      // Remove OSC sequences (e.g., \x1b]0;...\x07 for window title)
      .replace(/\x1b\][^\x07]*\x07/g, '')
      // Remove standard CSI sequences (including private mode with ?)
      .replace(/\x1b\[\??[0-9;]*[A-Za-z]/g, '')
      // Remove color codes (subset of above, but be explicit)
      .replace(/\x1b\[[0-9;]*m/g, '')
      // Remove backspace and the character before it
      .replace(/.\x08/g, '')
      .trim();

    console.log('[Terminal Title] Clean:', cleanTitle);

    if (cleanTitle && onTitleChange) {
      onTitleChange(cleanTitle);
    }
  }, [onTitleChange, terminalAgent, titleMarkerProp]);

  // Subscribe to terminal data
  useEffect(() => {
    const unsubscribeData = terminal.onData((event: { sessionId: string; data: string }) => {
      if (event.sessionId === sessionIdRef.current && terminalRef.current) {
        terminalRef.current.write(event.data);
        extractTitle(event.data);
        // Delay slightly to let xterm process the write, then find prompt position
        requestAnimationFrame(() => findPromptAndClip());
      }
    });

    const unsubscribeExit = terminal.onExit((event: { sessionId: string; exitCode: number; signal?: number }) => {
      if (event.sessionId === sessionIdRef.current) {
        setIsConnected(false);
        if (terminalRef.current) {
          terminalRef.current.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
        }
      }
    });

    return () => {
      unsubscribeData();
      unsubscribeExit();
    };
  }, [onClose, extractTitle, findPromptAndClip]);

  // Theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = isDarkMode() ? DARK_THEME : LIGHT_THEME;
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Handle container resize
  const handleResize = useCallback(() => {
    // Don't resize when tab is hidden - element has no dimensions and would shrink PTY
    if (!fitAddonRef.current || !terminalRef.current || !isVisible) return;

    fitAddonRef.current.fit();

    const term = terminalRef.current;
    setTerminalCols(term.cols);

    // Update cell dimensions
    const screen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement;
    if (screen && term.rows > 0 && term.cols > 0) {
      const rect = screen.getBoundingClientRect();
      setCellDimensions({
        width: rect.width / term.cols,
        height: rect.height / term.rows,
      });
    }

    if (sessionIdRef.current) {
      terminal.resize(sessionIdRef.current, term.cols, term.rows).catch(console.warn);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(handleResize));
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [handleResize]);

  // Focus and re-fit when visible
  useEffect(() => {
    if (isVisible && terminalRef.current) {
      terminalRef.current.focus();
      // Re-fit when becoming visible (may have been resized while hidden)
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    }
  }, [isVisible]);

  // Handle sending from composer - write text, wait, then send enter
  const handleComposerSend = useCallback(async (text: string) => {
    if (sessionIdRef.current && text.trim()) {
      // Send text first
      await terminal.write(sessionIdRef.current, text);
      // Wait 500ms for terminal to process the text
      await new Promise(resolve => setTimeout(resolve, 500));
      // Then send enter
      await terminal.write(sessionIdRef.current, '\n');
    }
  }, []);

  // Listen for unified composer sends
  useEffect(() => {
    const handleUnifiedSend = (e: Event) => {
      const customEvent = e as CustomEvent<{ tabId: string; text: string; type: string }>;
      if (customEvent.detail.tabId !== tabId || customEvent.detail.type !== 'terminal') return;
      handleComposerSend(customEvent.detail.text);
    };

    window.addEventListener('unified-composer:send', handleUnifiedSend);
    return () => window.removeEventListener('unified-composer:send', handleUnifiedSend);
  }, [tabId, handleComposerSend]);

  // Context menu for toggling rich input mode
  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault();

    const items: ContextMenuItem[] = [
      {
        label: richInputEnabled ? '✓ Rich Input' : 'Rich Input',
        action: 'toggle-rich-input',
      },
    ];

    const action = await showContextMenu(items, 'terminal');

    if (action === 'toggle-rich-input') {
      setRichInputEnabled(prev => !prev);
    }
  }, [richInputEnabled]);

  return (
    <div
      data-testid={TERMINAL_VIEW_ID}
      className="h-full w-full overflow-hidden"
      style={{
        display: isVisible ? 'flex' : 'none',
        flexDirection: 'column',
      }}
      onContextMenu={handleContextMenu}
    >
      {error ? (
        <div className="flex items-center justify-center h-full text-red-400 text-sm">
          {error}
        </div>
      ) : richInputEnabled ? (
        <>
          {/* Terminal area - clipped to hide prompt */}
          <div
            className="w-full relative flex-1 min-h-0"
            style={{
              paddingTop: 'var(--unit-padding)',
              paddingBottom: 'var(--unit-padding)',
              opacity: isReady ? 1 : 0,
            }}
          >
            <div
              ref={containerRef}
              className="w-full h-full"
            />
          </div>

        </>
      ) : (
        /* Uncontrolled mode - full terminal with hint overlay at cursor */
        <div
          className="w-full h-full relative"
          style={{
            paddingBottom: 'var(--unit-padding)',
            opacity: isReady ? 1 : 0,
          }}
        >
          <div
            ref={containerRef}
            className="w-full h-full"
          />
          {/* TODO: Add dictation feature - when user holds ⌘L, start voice input
              and stream transcribed text to the terminal. The PromptHintOverlay
              below shows how the hint should appear at the cursor position. */}
          {/* <PromptHintOverlay
            position={promptPosition}
            cellWidth={cellDimensions.width}
            cellHeight={cellDimensions.height}
          /> */}
        </div>
      )}
    </div>
  );
}
