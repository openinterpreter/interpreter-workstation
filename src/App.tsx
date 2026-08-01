import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { APP_DEFAULT_TRANSITION } from "@/lib/animationConfig";
import { Sidebar } from "./components/Sidebar";
import { AgentSidebar } from "../agent/components/AgentSidebar";
import { LayoutProvider } from "./contexts/LayoutContext";
import { AuthProvider } from "./contexts/AuthContext";
import { ToolServersProvider } from "./contexts/ToolServersContext";
import { CommandOverlayProvider } from "./contexts/CommandOverlayContext";
import { HelpProvider } from "./contexts/HelpContext";
import { useLayout } from "./hooks/useLayout";
import { CustomTitleBar } from "./components/layout/CustomTitleBar";
import { EditorLayout } from "./components/layout/EditorLayout";
import { FileDropOverlay } from "./components/layout/FileDropOverlay";
import { PersistentLayer } from "./components/layout/PersistentLayer";
import { MorphOverlay } from "./components/MorphOverlay";
import { ConnectionOverlay } from "./components/ConnectionOverlay";
import { MentionPreviewOverlay } from "./components/MentionPreviewOverlay";
import { windowingAPI } from "./api/windowingAPI";
import { AuthCallback } from "./components/auth/AuthCallback";
import { BrowserContextMenu } from "./components/BrowserContextMenu";
import { BrowserSelect } from "./components/BrowserSelect";
import { ResizeHandle } from "./components/ui/resize-handle";
import { ExtensionDownloadBar } from "./components/onboarding/ExtensionDownloadBar";
import { OnboardingFeedbackToast } from "./components/onboarding/OnboardingFeedbackToast";
import { OnboardingOverlay } from "./components/onboarding/OnboardingOverlay";
import { AppUpdateDialog } from "./components/AppUpdateDialog";
import { ComputerUseSetupModalHost } from "./components/ComputerUseSetupModalHost";
import { WindowsNativeToolsSetupNotice } from "./components/WindowsNativeToolsSetupNotice";
import { BrowserSplitOfferNotice } from "./components/BrowserSplitOfferNotice";
import { LowerLeftNoticeViewport } from "./components/LowerLeftNoticeViewport";
import { WorkspaceConfirmationModalHost } from "./components/WorkspaceConfirmationModalHost";
import { MarketingDemoShield } from "./components/MarketingDemoShield";
import { preloadOnboardingTourVideos, disposeOnboardingTourVideos } from "./components/onboarding/tourVideos";
import { MarketingDemoSurfaceRenderer } from "./demo/MarketingDemoSurfaceRenderer";
import { getOnboardingState } from "./api";
import { shouldShowOnboarding } from "./lib/onboardingGate";
import { appToasts, backgroundOpacity as backgroundOpacityIpc, theme as themeIpc, primaryColor as primaryColorIpc, windowIpc, locale as localeIpc, profiles as profilesIpc, openPath, getRuntimeSystemInfo } from "@/ipc";
import { getTabBarClosedPadding as computeTabBarClosedPadding, getTabBarRightPadding as computeTabBarRightPadding } from "./utils/titlebarLayout";
import { I18nextProvider } from 'react-i18next';
import i18n from './i18n';
import { initCustomColors } from "./components/settings/ColorCustomization";
import { ACTIVE_APP_BRAND, applyAppBrand, clearAppBrand } from "./branding";
import { PRIMARY_COLOR_VALUES, type PrimaryColorId } from "../shared/types/colors";
import { DEFAULT_BACKGROUND_OPACITY } from "../shared/uiDefaults";
import { useApprovalNotifications } from "./hooks/useApprovalNotifications";
import { useTokenUsageWarningToasts } from "./hooks/useTokenUsageWarningToasts";
import { ToastProvider, useToast, type ToastAction } from "./contexts/ToastContext";
import { useProgrammaticTaskNotifications } from "./hooks/useProgrammaticTaskNotifications";
import { LowerLeftNoticeProvider } from "./contexts/LowerLeftNoticesContext";
import type {
  BackgroundOpacityGetResponse,
  BackgroundOpacityChangedEvent,
  ThemeGetResponse,
  ThemeChangedEvent,
  PrimaryColorGetResponse,
  PrimaryColorChangedEvent,
  LocaleGetResponse,
  LocaleChangedEvent,
  ProfilesConfigRecoveredEvent,
} from "../electron/ipc/registry";
import { getMarketingDemoSurface, isMarketingDemoMode, isMarketingDemoWindowChromeEnabled } from "./demo/marketingDemo";

const FIRST_STARTUP_NUDGE_EVENT = 'onboarding:first-startup-nudge';
const TITLEBAR_LAYOUT_CHANGED_EVENT = 'titlebar:layout-changed';
const DEFAULT_TAB_BAR_RIGHT_RESERVE = 130;

function AppContent() {
  "use no memo";

  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const marketingDemoMode = isMarketingDemoMode();
  const marketingDemoWindowChrome = marketingDemoMode && isMarketingDemoWindowChromeEnabled();
  const [primaryColor, setPrimaryColor] = useState<PrimaryColorId>('blue');
  const [_isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [_isDraggingRight, setIsDraggingRight] = useState(false);
  const layout = useLayout();
  const {
    state,
    openFile,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    closeTab,
    setActiveTab: setActiveTabInLayout,
    moveTab,
    splitPaneAction,
    setActivePaneId,
    openNewTab,
    openSettings,
    toggleLeftSidebar,
    toggleRightSidebar,
    setLeftSidebarTab,
    resetToDefaults,
    setLayoutState,
    getState,
  } = layout;
  const runtimeSystemInfo = getRuntimeSystemInfo();
  const runtimePlatform = runtimeSystemInfo.platform;
  const isMac = runtimePlatform === 'darwin';
  const isWindows = runtimePlatform === 'win32';
  const nativeMacTransparencyDisabled = isMac
    && runtimeSystemInfo.nativeMacTransparencyEnabled === false;
  const [backgroundOpacity, setBackgroundOpacity] = useState(
    nativeMacTransparencyDisabled ? 1.0 : DEFAULT_BACKGROUND_OPACITY
  );
  useTokenUsageWarningToasts();
  const { showToast } = useToast();

  useEffect(() => {
    return appToasts.onShow((event: { message: string; variant: 'info' | 'success' | 'error'; autoDismissMs?: number }) => {
      showToast(event.message, event.variant, event.autoDismissMs);
    });
  }, [showToast]);

  // Onboarding state
  // null = still loading config, true = needs onboarding, false = onboarding not needed / completed
  const [isOnboarding, setIsOnboarding] = useState<boolean | null>(null);
  const [showOnboardingOverlay, setShowOnboardingOverlay] = useState(true);
  const configRecoveryNoticeCountRef = useRef(0);
  const windowSurfaceMode = isMac
    ? (nativeMacTransparencyDisabled ? 'opaque' : 'vibrant')
    : null;
  const effectiveWindowOverlayOpacity = nativeMacTransparencyDisabled ? 1 : backgroundOpacity;

  // Only warm onboarding videos while onboarding is actively visible.
  useEffect(() => {
    if (marketingDemoMode || isOnboarding !== true || !showOnboardingOverlay) {
      return;
    }

    preloadOnboardingTourVideos();

    return () => {
      disposeOnboardingTourVideos();
    };
  }, [isOnboarding, marketingDemoMode, showOnboardingOverlay]);

  useEffect(() => {
    if (!marketingDemoMode || typeof window === 'undefined' || window.parent === window) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const announceReady = () => {
      if (cancelled) return;
      window.parent.postMessage({ type: 'interpreter-marketing-demo-ready' }, '*');
    };

    firstFrameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(announceReady, 120);
      });
    });

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
      }
    };
  }, [marketingDemoMode]);

  useEffect(() => {
    const unsubscribe = profilesIpc.onConfigRecovered((event: ProfilesConfigRecoveredEvent) => {
      if (configRecoveryNoticeCountRef.current > 0) {
        return;
      }
      configRecoveryNoticeCountRef.current += 1;

      const actions: ToastAction[] = [
        {
          label: 'Settings > Profiles',
          onClick: () => openSettings(undefined, 'profiles'),
        },
      ];

      if (event.backupPath) {
        const backupPath = event.backupPath;
        actions.push({
          label: 'Open Invalid Config',
          onClick: () => {
            void (async () => {
              try {
                const result = await openPath(backupPath);
                if (result.error) {
                  showToast(`Could not open file: ${result.error}`, 'error', 5000);
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                showToast(`Could not open file: ${message}`, 'error', 5000);
              }
            })();
          },
        });
      }

      showToast(
        'Your model and provider configuration was invalid. Interpreter repaired it, reset invalid entries, and saved a backup.',
        'error',
        undefined,
        actions,
      );
    });

    return unsubscribe;
  }, [openSettings, showToast]);

  // Initialize locale from main process and listen for changes
  useEffect(() => {
    localeIpc.get().then((response: LocaleGetResponse) => {
      i18n.changeLanguage(response.language);
    }).catch(() => {});
    const unsubscribe = localeIpc.onChanged((event: LocaleChangedEvent) => {
      i18n.changeLanguage(event.language);
    });
    return unsubscribe;
  }, []);

  // Check if user needs onboarding on mount
  useEffect(() => {
    getOnboardingState()
      .then(({ state }) => {
        const needsOnboarding = shouldShowOnboarding(state);
        setIsOnboarding(needsOnboarding);
        if (!needsOnboarding) {
          setShowOnboardingOverlay(false);
        }
      })
      .catch((error) => {
        console.error('[App] Failed to load onboarding state:', error);
        setIsOnboarding(true);
        setShowOnboardingOverlay(true);
      });
  }, []);

  // Listen for restart-onboarding event from Settings
  useEffect(() => {
    const handleRestartOnboarding = () => {
      setIsOnboarding(true);
      setShowOnboardingOverlay(true);
    };
    window.addEventListener('settings:restart-onboarding', handleRestartOnboarding);
    return () => window.removeEventListener('settings:restart-onboarding', handleRestartOnboarding);
  }, []);

  // Handle onboarding completion: fade out overlay, then fade in app, then nudge the composer.
  const handleOnboardingComplete = useCallback(() => {
    // Phase 1: Fade out the onboarding overlay (AnimatePresence exit animation)
    setShowOnboardingOverlay(false);

    // Phase 2: After overlay fade-out completes (~300ms), show the app
    setTimeout(() => {
      setIsOnboarding(false);

      // Phase 3: After app fade-in completes (~400ms), guide the first message without opening Explorer.
      setTimeout(() => {
        window.dispatchEvent(new Event(FIRST_STARTUP_NUDGE_EVENT));
      }, 450);
    }, 350);
  }, []);

  // Refs for DOM elements we animate directly
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const rightSidebarRef = useRef<HTMLDivElement>(null);
  const leftContentRef = useRef<HTMLDivElement>(null);
  const rightContentRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const rightResizeRef = useRef<HTMLDivElement>(null);
  const tabBarRightPaddingRef = useRef<HTMLDivElement | null>(null);

  // Current animated widths (not React state - we update DOM directly)
  const animatedLeftWidth = useRef(state.leftSidebar.isOpen ? state.leftSidebar.width || 300 : 0);
  const animatedRightWidth = useRef(state.rightSidebar.isOpen ? state.rightSidebar.width || 400 : 0);
  const animationRef = useRef<number | null>(null);

  // Calculate tab bar closed padding from CSS variables (recalculates for fullscreen)
  const getTabBarClosedPadding = useCallback(() => {
    const style = getComputedStyle(document.documentElement);
    const trafficLightsWidth = isMac
      ? (parseFloat(style.getPropertyValue('--traffic-lights-width')) || 0)
      : 0;
    const unitPadding = parseFloat(style.getPropertyValue('--unit-padding')) || 8;
    const unitElementHeight = parseFloat(style.getPropertyValue('--unit-element-height')) || 34;
    const windowsLeftReserve = isWindows
      ? (parseFloat(style.getPropertyValue('--windows-titlebar-left-reserve')) || 0)
      : 0;
    return computeTabBarClosedPadding({
      isMac,
      isWindows,
      trafficLightsWidth,
      unitPadding,
      unitElementHeight,
      windowsLeftReserve,
    });
  }, [isMac, isWindows]);

  const getTabBarRightReserve = useCallback(() => {
    if (!isWindows) return DEFAULT_TAB_BAR_RIGHT_RESERVE;
    const style = getComputedStyle(document.documentElement);
    const windowsRightReserve = parseFloat(style.getPropertyValue('--windows-titlebar-right-reserve')) || 0;
    if (marketingDemoMode) {
      return windowsRightReserve;
    }
    return Math.max(DEFAULT_TAB_BAR_RIGHT_RESERVE, windowsRightReserve);
  }, [isWindows, marketingDemoMode]);

  const setTrafficLightsWidth = useCallback((isFullScreen: boolean) => {
    const width = isMac && !isFullScreen && (!marketingDemoMode || marketingDemoWindowChrome) ? '80px' : '0px';
    document.documentElement.style.setProperty('--traffic-lights-width', width);
  }, [isMac, marketingDemoMode, marketingDemoWindowChrome]);

  // Helper to apply current values to DOM immediately
  const applyValues = useCallback((leftWidth: number, rightWidth: number) => {
    let effectiveLeftWidth = leftWidth;
    let effectiveRightWidth = rightWidth;

    const totalSidebarWidth = leftWidth + rightWidth;
    if (totalSidebarWidth > 0) {
      // Keep both sidebars responsive at narrow widths, but avoid collapsing
      // an open sidebar to zero-width during restore/resize transitions.
      const minVisibleLeftWidth = leftWidth > 0 ? 120 : 0;
      const minVisibleRightWidth = rightWidth > 0 ? 120 : 0;
      const baseMinCenterWidth = Math.min(420, Math.max(280, window.innerWidth * 0.5));
      const minCenterWidth = Math.max(
        120,
        Math.min(baseMinCenterWidth, window.innerWidth - minVisibleLeftWidth - minVisibleRightWidth),
      );
      const availableSidebarWidth = Math.max(
        minVisibleLeftWidth + minVisibleRightWidth,
        window.innerWidth - minCenterWidth,
      );
      if (totalSidebarWidth > availableSidebarWidth) {
        const scale = availableSidebarWidth <= 0 ? 0 : availableSidebarWidth / totalSidebarWidth;
        effectiveLeftWidth = leftWidth > 0 ? Math.max(0, Math.round(leftWidth * scale)) : 0;
        effectiveRightWidth = rightWidth > 0 ? Math.max(0, Math.round(rightWidth * scale)) : 0;

        if (leftWidth > 0 && effectiveLeftWidth < minVisibleLeftWidth) {
          const deficit = minVisibleLeftWidth - effectiveLeftWidth;
          effectiveLeftWidth = minVisibleLeftWidth;
          effectiveRightWidth = Math.max(0, effectiveRightWidth - deficit);
        }
        if (rightWidth > 0 && effectiveRightWidth < minVisibleRightWidth) {
          const deficit = minVisibleRightWidth - effectiveRightWidth;
          effectiveRightWidth = minVisibleRightWidth;
          effectiveLeftWidth = Math.max(0, effectiveLeftWidth - deficit);
        }
      }
    }

    if (leftSidebarRef.current) {
      leftSidebarRef.current.style.width = `${effectiveLeftWidth}px`;
    }
    if (leftContentRef.current) {
      leftContentRef.current.style.width = `${effectiveLeftWidth}px`;
    }
    if (rightSidebarRef.current) {
      rightSidebarRef.current.style.width = `${effectiveRightWidth}px`;
    }
    if (rightContentRef.current) {
      rightContentRef.current.style.width = `${effectiveRightWidth}px`;
    }
    // Keep center area from overlapping the absolutely-positioned right sidebar
    if (centerRef.current) {
      centerRef.current.style.marginRight = `${effectiveRightWidth}px`;
    }
    // Position the right resize handle at the left edge of the right sidebar
    if (rightResizeRef.current) {
      rightResizeRef.current.style.right = `${effectiveRightWidth}px`;
    }
    // Spacer ensures the first tab is always at least `closedPadding` px from the
    // window's left edge:  sidebar_width + spacer >= closedPadding.
    // This single formula handles open, closing, closed, and opening — no special cases.
    // Set via CSS variable on root so React re-renders can never reset it.
    const closedPadding = getTabBarClosedPadding();
    const leftPadding = Math.max(0, closedPadding - effectiveLeftWidth);
    document.documentElement.style.setProperty('--left-sidebar-effective-width', `${effectiveLeftWidth}px`);
    document.documentElement.style.setProperty('--tab-bar-left-spacer', `${leftPadding}px`);
    if (tabBarRightPaddingRef.current) {
      const rightReserve = getTabBarRightReserve();
      tabBarRightPaddingRef.current.style.width = `${computeTabBarRightPadding(effectiveRightWidth, rightReserve)}px`;
    }
    // Set CSS variable for first tab corner opacity (1 when closed, 0 when aligned with sidebar)
    const firstTabEdgeOpacity = closedPadding > 0 ? Math.min(1, leftPadding / closedPadding) : 0;
    document.documentElement.style.setProperty('--first-tab-edge-opacity', String(firstTabEdgeOpacity));
    animatedLeftWidth.current = effectiveLeftWidth;
    animatedRightWidth.current = effectiveRightWidth;

    // Synchronously measure and update all pane shell SVGs in the SAME frame
    // so the tab chrome never lags behind the spacer position.
    const syncMap = (window as any).__paneShellSync as Map<string, () => void> | undefined;
    if (syncMap) {
      syncMap.forEach((fn) => fn());
    }
  }, [getTabBarClosedPadding, getTabBarRightReserve]);

  // Animate sidebar and tabs together using requestAnimationFrame
  const animateSidebars = useCallback((
    leftTarget: number,
    rightTarget: number,
    duration: number = 200
  ) => {
    // Cancel any existing animation
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    const leftStart = animatedLeftWidth.current;
    const rightStart = animatedRightWidth.current;

    const syncPaneRects = () => {
      const syncFn = (window as any).__updatePaneRectImperative;
      if (syncFn) {
        document.querySelectorAll('[data-pane-id]').forEach((el) => {
          const paneId = el.getAttribute('data-pane-id');
          if (paneId) {
            const r = el.getBoundingClientRect();
            syncFn(paneId, { top: r.top, left: r.left, width: r.width, height: r.height });
          }
        });
      }
    };

    // If already at target, just apply and return
    if (leftStart === leftTarget && rightStart === rightTarget) {
      applyValues(leftTarget, rightTarget);
      // NOTE(victor): Deferred sync ensures pane rects are measured after DOM has settled
      // Uses rAF so child components and ResizeObservers are mounted
      requestAnimationFrame(() => {
        syncPaneRects();
        window.dispatchEvent(new CustomEvent('layout:sidebar-settled'));
      });
      return;
    }

    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic for smooth deceleration
      const eased = 1 - Math.pow(1 - progress, 3);

      const leftCurrent = leftStart + (leftTarget - leftStart) * eased;
      const rightCurrent = rightStart + (rightTarget - rightStart) * eased;

      applyValues(leftCurrent, rightCurrent);

      // Keep persistent tab overlays in sync with pane positions during animation
      syncPaneRects();

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        animationRef.current = null;
        syncPaneRects();
        window.dispatchEvent(new CustomEvent('layout:sidebar-settled'));
      }
    };

    // Run first frame IMMEDIATELY (synchronously) to prevent flash
    animate(startTime);

    // Continue animation on next frame
    if (leftStart !== leftTarget || rightStart !== rightTarget) {
      animationRef.current = requestAnimationFrame(animate);
    }
  }, [applyValues, state.leftSidebar.width, state.rightSidebar.width]);

  const handleTabBarRightPaddingRef = useCallback((ref: HTMLDivElement | null) => {
    tabBarRightPaddingRef.current = ref;
    if (ref) {
      // Apply current value immediately
      const rightReserve = getTabBarRightReserve();
      ref.style.width = `${computeTabBarRightPadding(animatedRightWidth.current, rightReserve)}px`;
    }
  }, [getTabBarRightReserve]);

  // Set initial values BEFORE first paint using useLayoutEffect
  useLayoutEffect(() => {
    setTrafficLightsWidth(false);
    const leftWidth = state.leftSidebar.isOpen ? state.leftSidebar.width || 300 : 0;
    const rightWidth = state.rightSidebar.isOpen ? state.rightSidebar.width || 400 : 0;
    applyValues(leftWidth, rightWidth);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  // Trigger animation when sidebar open state changes - use useLayoutEffect to run before paint
  useLayoutEffect(() => {
    const leftTarget = state.leftSidebar.isOpen ? state.leftSidebar.width || 300 : 0;
    const rightTarget = state.rightSidebar.isOpen ? state.rightSidebar.width || 400 : 0;
    animateSidebars(leftTarget, rightTarget);
  }, [state.leftSidebar.isOpen, state.rightSidebar.isOpen, animateSidebars, state.leftSidebar.width, state.rightSidebar.width]);

  // Recompute tab spacers when titlebar controls resize (Windows menu + right controls).
  useEffect(() => {
    const handleTitlebarLayoutChanged = () => {
      applyValues(animatedLeftWidth.current, animatedRightWidth.current);
    };
    window.addEventListener(TITLEBAR_LAYOUT_CHANGED_EVENT, handleTitlebarLayoutChanged);
    return () => window.removeEventListener(TITLEBAR_LAYOUT_CHANGED_EVENT, handleTitlebarLayoutChanged);
  }, [applyValues]);

  // Update traffic-lights-width and tab bar padding when fullscreen changes
  useEffect(() => {
    const unsubscribe = windowIpc.onFullscreenChanged((event: { isFullScreen: boolean }) => {
      setTrafficLightsWidth(event.isFullScreen);
      // Recalculate tab bar padding with new CSS variable value
      requestAnimationFrame(() => {
        applyValues(animatedLeftWidth.current, animatedRightWidth.current);
      });
    });
    return unsubscribe;
  }, [applyValues, setTrafficLightsWidth]);

  useEffect(() => {
    const handleResize = () => {
      const leftWidth = state.leftSidebar.isOpen ? state.leftSidebar.width || 300 : 0;
      const rightWidth = state.rightSidebar.isOpen ? state.rightSidebar.width || 400 : 0;
      applyValues(leftWidth, rightWidth);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [applyValues, state.leftSidebar.isOpen, state.leftSidebar.width, state.rightSidebar.isOpen, state.rightSidebar.width]);

  // Update width when resizing (instant, no animation)
  useLayoutEffect(() => {
    if (state.leftSidebar.isOpen) {
      const width = state.leftSidebar.width || 300;
      // Only update if not currently animating
      if (!animationRef.current) {
        applyValues(width, animatedRightWidth.current);
      }
    }
  }, [state.leftSidebar.width, state.leftSidebar.isOpen, applyValues]);

  useLayoutEffect(() => {
    if (state.rightSidebar.isOpen) {
      const width = state.rightSidebar.width || 400;
      // Only update if not currently animating
      if (!animationRef.current) {
        applyValues(animatedLeftWidth.current, width);
      }
    }
  }, [state.rightSidebar.width, state.rightSidebar.isOpen, applyValues]);

  // Resize handlers - update DOM directly for instant response, save to state on release
  const handleLeftResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingLeft(true);

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(600, e.clientX));
      // Update DOM directly - no React state during drag
      applyValues(newWidth, animatedRightWidth.current);
    };

    const handleMouseUp = (e: MouseEvent) => {
      setIsDraggingLeft(false);
      const finalWidth = Math.max(200, Math.min(600, e.clientX));
      // Save to React state only on release
      setLeftSidebarWidth(finalWidth);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [applyValues, setLeftSidebarWidth]);

  const handleRightResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingRight(true);

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(200, Math.min(800, window.innerWidth - e.clientX));
      // Update DOM directly - no React state during drag
      applyValues(animatedLeftWidth.current, newWidth);
    };

    const handleMouseUp = (e: MouseEvent) => {
      setIsDraggingRight(false);
      const finalWidth = Math.max(200, Math.min(800, window.innerWidth - e.clientX));
      // Save to React state only on release
      setRightSidebarWidth(finalWidth);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [applyValues, setRightSidebarWidth]);

  // Initialize WindowingAPI and expose on window
  useEffect(() => {
    windowingAPI.init(() => ({
      state,
      actions: {
        openFile,
        openFolder: layout.openFolder,
        openBrowser: layout.openBrowser,
        closeTab,
        setActiveTab: setActiveTabInLayout,
        moveTab,
        splitPaneAction,
        setActivePaneId,
        openNewTab,
        toggleLeftSidebar,
        toggleRightSidebar,
        setLeftSidebarTab,
        setLeftSidebarWidth,
        setRightSidebarWidth,
        resetToDefaults,
        setLayoutState,
        getState,
      },
    }));

    // Expose on window for dev tools
    if (typeof window !== 'undefined') {
      (window as any).windowingAPI = windowingAPI;
    }

    return () => {
      if (typeof window !== 'undefined') {
        delete (window as any).windowingAPI;
      }
    };
  }, [
    state,
    openFile,
    layout.openFolder,
    closeTab,
    setActiveTabInLayout,
    moveTab,
    splitPaneAction,
    setActivePaneId,
    openNewTab,
    toggleLeftSidebar,
    toggleRightSidebar,
    setLeftSidebarTab,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    resetToDefaults,
    setLayoutState,
    getState,
  ]);

  // Load initial background opacity and listen for changes
  useEffect(() => {
    backgroundOpacityIpc.get().then((response: BackgroundOpacityGetResponse) => {
      setBackgroundOpacity(response.opacity);
    }).catch((error: unknown) => {
      console.error('[App] Failed to load background opacity:', error);
    });

    const unsubscribe = backgroundOpacityIpc.onChanged((event: BackgroundOpacityChangedEvent) => {
      setBackgroundOpacity(event.opacity);
    });

    return unsubscribe;
  }, []);

  // Load initial theme and listen for changes
  useEffect(() => {
    // 1. Fetch initial theme
    themeIpc.get().then((response: ThemeGetResponse) => {
      setTheme(response.theme);
    }).catch((error: unknown) => {
      console.error('[App] Failed to load theme:', error);
    });

    // 2. Listen for changes
    const unsubscribe = themeIpc.onChanged((event: ThemeChangedEvent) => {
      setTheme(event.theme);
    });

    return unsubscribe;
  }, []);

  // Apply theme to document - shadcn uses .dark class
  // useLayoutEffect runs synchronously BEFORE browser paint, preventing
  // flash of wrong theme (dark vibrancy window + light mode UI colors)
  useLayoutEffect(() => {
    const root = document.documentElement;

    const applyTheme = () => {
      root.classList.remove('dark');
      if (theme === 'dark') {
        root.classList.add('dark');
      } else if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark) {
          root.classList.add('dark');
        }
      }
    };

    applyTheme();

    // When theme is 'system', listen for OS theme changes so we stay in sync
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme();
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  // Load initial primary color and listen for changes
  useEffect(() => {
    primaryColorIpc.get().then((response: PrimaryColorGetResponse) => {
      setPrimaryColor(response.color as PrimaryColorId);
    }).catch((error: unknown) => {
      console.error('[App] Failed to load primary color:', error);
    });

    const unsubscribe = primaryColorIpc.onChanged((event: PrimaryColorChangedEvent) => {
      setPrimaryColor(event.color as PrimaryColorId);
    });

    return unsubscribe;
  }, []);

  // Apply primary color CSS variables
  useEffect(() => {
    const root = document.documentElement;
    const colorValues = PRIMARY_COLOR_VALUES[primaryColor] || PRIMARY_COLOR_VALUES.gray;

    // Determine if we're in dark mode
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    // Apply the primary color CSS variable
    root.style.setProperty('--primary', isDark ? colorValues.dark : colorValues.light);
    root.style.setProperty('--primary-foreground', colorValues.foreground);
  }, [primaryColor, theme]);

  useEffect(() => {
    const root = document.documentElement;
    applyAppBrand(root, ACTIVE_APP_BRAND);
    return () => {
      clearAppBrand(root, ACTIVE_APP_BRAND);
    };
  }, []);

  // On macOS, keep the renderer on one shell mode for the whole session. The
  // opacity slider should only fade a single back sheet, not flip the app
  // between different shell/background implementations.
  useEffect(() => {
    const root = document.documentElement;
    if (windowSurfaceMode) {
      root.dataset.windowSurfaceMode = windowSurfaceMode;
    } else {
      delete root.dataset.windowSurfaceMode;
    }
    return () => {
      delete root.dataset.windowSurfaceMode;
    };
  }, [windowSurfaceMode]);

  useEffect(() => {
    const root = document.documentElement;
    if (marketingDemoMode) {
      root.dataset.marketingDemo = 'true';
    } else {
      delete root.dataset.marketingDemo;
    }
    return () => {
      delete root.dataset.marketingDemo;
    };
  }, [marketingDemoMode]);

  // Initialize custom colors from localStorage
  useEffect(() => {
    return initCustomColors();
  }, []);

  // Desktop notifications for approvals/questions
  useApprovalNotifications();
  useProgrammaticTaskNotifications();

  // Note: Keyboard shortcuts (Cmd+N, Cmd+T, Cmd+Shift+L, Cmd+W, Cmd+K, Ctrl+Space, etc.)
  // are handled globally via Electron menu → IPC → LayoutContext
  // See electron/menu.ts and src/contexts/LayoutContext.tsx

  const handleFileOpen = useCallback((path: string) => {
    openFile(path);
  }, [openFile]);

  // Determine if we should hide the app behind the onboarding overlay
  const appHidden = isOnboarding === true || isOnboarding === null;
  // Defer mounting expensive/interactive surfaces until onboarding finishes so
  // they initialize from post-onboarding settings (e.g., default profile/model).
  const shouldRenderMainSurfaces = isOnboarding === false;
  const marketingDemoSurface = marketingDemoMode ? getMarketingDemoSurface() : null;

  if (marketingDemoSurface) {
    return <MarketingDemoSurfaceRenderer surface={marketingDemoSurface} />;
  }

  return (
    <>
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: 'var(--oa-shell-overlay)',
          opacity: effectiveWindowOverlayOpacity,
        }}
      />

      {/* Extension download progress - hidden during onboarding */}
      {!isOnboarding && !marketingDemoMode && (
        <ExtensionDownloadBar />
      )}
      {!isOnboarding && !marketingDemoMode && (
        <BrowserSplitOfferNotice />
      )}
      <OnboardingFeedbackToast visible={isOnboarding === true} />

      <LowerLeftNoticeViewport
        leftSidebarOpen={state.leftSidebar.isOpen}
        leftSidebarWidth={state.leftSidebar.width || 300}
      />

      {/* Main container - full height, relative for absolute title bar */}
      {/* During onboarding: opacity-0 and pointer-events-none to hide app behind overlay */}
      <div
        className={`app-window-shell h-screen bg-transparent text-foreground relative z-10 ${
          appHidden ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
        style={{ transition: 'opacity 400ms ease' }}
      >
        {/* Title bar - positioned on top */}
        <CustomTitleBar />

        {/* Full-height layout with JS-animated sidebars */}
        {/* Right sidebar is absolutely positioned so it's always pinned to the right edge */}
        {/* regardless of left sidebar width (prevents flex overflow on narrow windows) */}
        <div
          className="app-workspace-shell relative flex h-full"
          style={{ backgroundColor: 'transparent' }}
        >
          {/* Left Section: Sidebar - outer width animates, inner stays fixed for smooth slide */}
          {/* Border provided by ResizeHandle */}
          <div
            ref={leftSidebarRef}
            className="h-full flex-shrink-0 overflow-hidden"
          >
            <div
              ref={leftContentRef}
              className="h-full box-border"
            >
              {shouldRenderMainSurfaces ? <Sidebar onFileOpen={handleFileOpen} /> : null}
            </div>
          </div>

          {/* Left resize handle - invisible but provides drag interaction */}
          {state.leftSidebar.isOpen && (
            <ResizeHandle
              onMouseDown={handleLeftResizeStart}
              orientation="vertical"
            />
          )}

          {/* Center: Editor - takes remaining space, marginRight set imperatively to avoid right sidebar */}
          <div ref={centerRef} className="relative h-full min-w-0 flex-1">
            {shouldRenderMainSurfaces ? (
              <>
                <EditorLayout onTopRightPaddingRef={handleTabBarRightPaddingRef} />
                <PersistentLayer />
                <FileDropOverlay />
                <MorphOverlay />
                <ConnectionOverlay />
                <MentionPreviewOverlay />
              </>
            ) : null}
          </div>

          {/* Right resize handle - absolutely positioned at left edge of right sidebar */}
          {state.rightSidebar.isOpen && !marketingDemoMode && (
            <div ref={rightResizeRef} className="absolute top-0 bottom-0 z-[9999]">
              <ResizeHandle
                onMouseDown={handleRightResizeStart}
                orientation="vertical"
              />
            </div>
          )}

          {/* Right: Agent Sidebar - absolutely positioned, always pinned to right edge */}
          {/* ml-auto right-aligns content so it slides off to the right when closing */}
          <div
            ref={rightSidebarRef}
            className={`absolute top-0 right-0 bottom-0 overflow-hidden ${
              marketingDemoMode ? 'pointer-events-none' : ''
            }`}
          >
            <div
              ref={rightContentRef}
              className="h-full ml-auto box-border"
            >
              {shouldRenderMainSurfaces ? <AgentSidebar /> : null}
            </div>
          </div>
        </div>
      </div>

      {/* Onboarding overlay -- renders above everything at z-50 */}
      <AnimatePresence>
        {showOnboardingOverlay && isOnboarding && (
          <motion.div
            key="onboarding-overlay"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="fixed inset-0 z-50"
          >
            <OnboardingOverlay onComplete={handleOnboardingComplete} />
          </motion.div>
        )}
      </AnimatePresence>

      {marketingDemoMode ? <MarketingDemoShield /> : null}

      {!marketingDemoMode ? <WorkspaceConfirmationModalHost /> : null}
      {!marketingDemoMode ? <ComputerUseSetupModalHost /> : null}
      {!marketingDemoMode ? <AppUpdateDialog /> : null}
      {!marketingDemoMode ? <WindowsNativeToolsSetupNotice /> : null}
    </>
  );
}

export default function App() {
  // Check if we're on the auth callback route
  const isAuthCallback = window.location.pathname === '/auth/complete';

  if (isAuthCallback) {
    return <AuthCallback />;
  }

  return (
    <MotionConfig transition={APP_DEFAULT_TRANSITION} reducedMotion="user">
      <I18nextProvider i18n={i18n}>
        <LowerLeftNoticeProvider>
          <ToastProvider>
            <AuthProvider>
              <ToolServersProvider>
                <LayoutProvider>
                  <HelpProvider>
                    <CommandOverlayProvider>
                      <AppContent />
                      <BrowserContextMenu />
                      <BrowserSelect />
                    </CommandOverlayProvider>
                  </HelpProvider>
                </LayoutProvider>
              </ToolServersProvider>
            </AuthProvider>
          </ToastProvider>
        </LowerLeftNoticeProvider>
      </I18nextProvider>
    </MotionConfig>
  );
}
