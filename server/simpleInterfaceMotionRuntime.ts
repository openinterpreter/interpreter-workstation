/**
 * App-shipped subset of Julian Ibelik's Motion Primitives for generated
 * interfaces. Motion Primitives is MIT licensed: https://motion-primitives.com
 * Components are adapted to run without a project-local Tailwind dependency.
 */
export const SIMPLE_INTERFACE_MOTION_MODULE = `import React from 'react';
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useInView,
  useReducedMotion,
} from 'motion/react';

export { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion };

const itemBase = { hidden: { opacity: 0 }, visible: { opacity: 1 } };
const presets = {
  fade: {},
  slide: { hidden: { y: 20 }, visible: { y: 0 } },
  scale: { hidden: { scale: .9 }, visible: { scale: 1 } },
  blur: { hidden: { filter: 'blur(8px)' }, visible: { filter: 'blur(0px)' } },
  'blur-slide': { hidden: { filter: 'blur(8px)', y: 16 }, visible: { filter: 'blur(0px)', y: 0 } },
};

function withOpacity(variants = {}) {
  return {
    hidden: { ...itemBase.hidden, ...(variants.hidden || {}) },
    visible: { ...itemBase.visible, ...(variants.visible || {}) },
    exit: { opacity: 0, ...(variants.exit || {}) },
  };
}

export function AnimatedGroup({ children, className, variants, preset = 'fade', as = 'div', asChild = 'div', stagger = .07, ...props }) {
  const reduceMotion = useReducedMotion();
  const Container = React.useMemo(() => motion.create(as), [as]);
  const Item = React.useMemo(() => motion.create(asChild), [asChild]);
  const containerVariants = variants?.container || {
    hidden: {},
    visible: { transition: { staggerChildren: reduceMotion ? 0 : stagger } },
  };
  const itemVariants = variants?.item || withOpacity(reduceMotion ? {} : (presets[preset] || {}));
  return <Container initial="hidden" animate="visible" variants={containerVariants} className={className} {...props}>
    {React.Children.map(children, (child, index) => <Item key={index} variants={itemVariants}>{child}</Item>)}
  </Container>;
}

const textPresets = {
  fade: {},
  blur: { hidden: { filter: 'blur(10px)' }, visible: { filter: 'blur(0px)' }, exit: { filter: 'blur(10px)' } },
  'fade-in-blur': { hidden: { y: 14, filter: 'blur(10px)' }, visible: { y: 0, filter: 'blur(0px)' }, exit: { y: 8, filter: 'blur(8px)' } },
  scale: { hidden: { scale: .92 }, visible: { scale: 1 }, exit: { scale: .96 } },
  slide: { hidden: { y: 16 }, visible: { y: 0 }, exit: { y: 8 } },
};

function splitText(text, per) {
  if (per === 'line') return text.split('\\n');
  if (per === 'char') return Array.from(text);
  return text.split(/(\\s+)/);
}

export function TextEffect({ children, per = 'word', as = 'p', preset = 'fade', className, delay = 0, speedReveal = 1, speedSegment = 1, trigger = true, variants, style }) {
  const reduceMotion = useReducedMotion();
  const Tag = React.useMemo(() => motion.create(as), [as]);
  const segments = splitText(String(children ?? ''), per);
  const item = withOpacity(reduceMotion ? {} : (variants?.item || textPresets[preset] || {}));
  const container = variants?.container || {
    hidden: {},
    visible: { transition: { delayChildren: delay, staggerChildren: reduceMotion ? 0 : ({ char: .025, word: .045, line: .08 }[per] / speedReveal) } },
    exit: { transition: { staggerDirection: -1 } },
  };
  return <AnimatePresence mode="popLayout">
    {trigger && <Tag initial="hidden" animate="visible" exit="exit" variants={container} className={className} style={style}>
      {per !== 'line' && <span className="io-sr-only">{children}</span>}
      {segments.map((segment, index) => <motion.span
        aria-hidden={per !== 'line' ? 'true' : undefined}
        className={per === 'line' ? 'io-motion-line' : 'io-motion-segment'}
        key={index}
        variants={item}
        transition={{ duration: reduceMotion ? 0 : .3 / speedSegment }}
      >{segment}</motion.span>)}
    </Tag>}
  </AnimatePresence>;
}

export function TextShimmer({ children, as = 'span', className, duration = 2, spread = 2 }) {
  const Tag = React.useMemo(() => motion.create(as), [as]);
  const dynamicSpread = String(children).length * spread;
  return <Tag
    className={'io-text-shimmer ' + (className || '')}
    initial={{ backgroundPosition: '100% center' }}
    animate={{ backgroundPosition: '0% center' }}
    transition={{ repeat: Infinity, duration, ease: 'linear' }}
    style={{ '--io-shimmer-spread': dynamicSpread + 'px' }}
  >{children}</Tag>;
}

export function InView({ children, variants = { hidden: { opacity: 0 }, visible: { opacity: 1 } }, transition, viewOptions, as = 'div', once = true, ...props }) {
  const ref = React.useRef(null);
  const visible = useInView(ref, { once, ...viewOptions });
  const Tag = React.useMemo(() => motion.create(as), [as]);
  return <Tag ref={ref} initial="hidden" animate={visible ? 'visible' : 'hidden'} variants={variants} transition={transition} {...props}>{children}</Tag>;
}

export function TransitionPanel({ children, activeIndex, className, transition = { duration: .22, ease: [.16, 1, .3, 1] }, variants = { enter: { opacity: 0, y: 8, filter: 'blur(4px)' }, center: { opacity: 1, y: 0, filter: 'blur(0px)' }, exit: { opacity: 0, y: -6, filter: 'blur(3px)' } }, ...props }) {
  return <div className={'io-transition-panel ' + (className || '')}>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.div key={activeIndex} variants={variants} transition={transition} initial="enter" animate="center" exit="exit" {...props}>
        {React.Children.toArray(children)[activeIndex]}
      </motion.div>
    </AnimatePresence>
  </div>;
}
`;
