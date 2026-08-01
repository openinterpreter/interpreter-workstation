import { AnimatePresence, motion } from 'motion/react';
import { TintedActionBox } from './TintedActionBox.js';

interface ScopeSelectionSheenElement {
  id: string;
  tier: 'container' | 'control';
  localLeft: number;
  localTop: number;
  width: number;
  height: number;
}

interface ScopeSelectionSheenProps {
  visible: boolean;
  scopeWidth: number;
  scopeHeight: number;
  elements: ScopeSelectionSheenElement[];
  primaryColor: string;
}

export function ScopeSelectionSheen({
  visible,
  scopeWidth,
  scopeHeight,
  elements,
  primaryColor,
}: ScopeSelectionSheenProps) {
  const renderableElements = elements
    .filter((element) => element.width > 0 && element.height > 0)
    .map((element) => {
      const shouldSquareSmallTarget = element.tier === 'control'
        && element.height > element.width
        && element.width <= 44
        && element.height <= 96;
      if (!shouldSquareSmallTarget) return element;
      return {
        ...element,
        localTop: element.localTop + (element.height - element.width) / 2,
        height: element.width,
      };
    });

  return (
    <AnimatePresence initial={false}>
      {visible && scopeWidth > 0 && scopeHeight > 0 && (
        <motion.div
          className="scope-selection-thinking-layer scope-selection-spark-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          style={{
            '--spark-color': primaryColor,
          }}
          aria-hidden="true"
        >
          {renderableElements.map((element, index) => (
            <TintedActionBox
              key={element.id}
              className={`scope-selection-spark scope-selection-spark-${element.tier}`}
              color={primaryColor}
              left={element.localLeft}
              top={element.localTop}
              width={element.width}
              height={element.height}
              index={index}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
