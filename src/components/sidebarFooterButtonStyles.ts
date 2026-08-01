export const SIDEBAR_FOOTER_BUTTON_BASE_CLASSNAME = [
  'h-[calc(var(--unit-height)-10px)]',
  'rounded-[12px]',
  'border',
  'border-transparent',
  'bg-transparent',
  'px-2.5',
  'text-ui-sm',
  'font-medium',
  'shadow-none',
  'text-[#2d3440]',
  'hover:border-transparent',
  'hover:bg-black/[0.02]',
  'hover:text-[#202123]',
  'aria-expanded:border-transparent',
  'aria-expanded:bg-black/[0.02]',
  'aria-expanded:text-[#202123]',
  'dark:text-[#e0e0e0]',
  'dark:hover:border-transparent',
  'dark:hover:bg-white/[0.04]',
  'dark:hover:text-[#f5f5f5]',
  'dark:aria-expanded:border-transparent',
  'dark:aria-expanded:bg-white/[0.04]',
  'dark:aria-expanded:text-[#f5f5f5]',
].join(' ');

export const SIDEBAR_FOOTER_FULL_WIDTH_BUTTON_CLASSNAME = [
  SIDEBAR_FOOTER_BUTTON_BASE_CLASSNAME,
  'w-full',
  'min-w-0',
  'text-left',
  'justify-start',
  'gap-2',
].join(' ');

export const SIDEBAR_FOOTER_ROW_PRIMARY_BUTTON_CLASSNAME = [
  SIDEBAR_FOOTER_BUTTON_BASE_CLASSNAME,
  'justify-start',
  'flex-1',
  'min-w-0',
  'gap-2',
].join(' ');

export const SIDEBAR_FOOTER_SECONDARY_BUTTON_CLASSNAME = [
  SIDEBAR_FOOTER_BUTTON_BASE_CLASSNAME,
  'min-w-[104px]',
  'shrink-0',
  'text-left',
  'justify-start',
  'gap-2',
].join(' ');

export const SIDEBAR_FOOTER_LEADING_SLOT_CLASSNAME = [
  'flex',
  'size-7',
  'shrink-0',
  'items-center',
  'justify-center',
].join(' ');
