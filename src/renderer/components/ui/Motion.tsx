import { forwardRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";

export function Presence(props: {
  children: ReactNode;
  initial?: boolean;
}) {
  return <AnimatePresence initial={props.initial ?? false}>{props.children}</AnimatePresence>;
}

type MotionDivProps = HTMLMotionProps<"div"> & {
  distance?: number;
  duration?: number;
};

export const FadeScale = forwardRef<HTMLDivElement, MotionDivProps>(function FadeScale({
  children,
  distance: _distance,
  duration = 0.14,
  ...props
}, ref) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      {...props}
      ref={ref}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
      transition={{ duration: reducedMotion ? 0.01 : duration, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
});

export const FadeSlide = forwardRef<HTMLDivElement, MotionDivProps>(function FadeSlide({
  children,
  distance = 4,
  duration = 0.12,
  ...props
}, ref) {
  const reducedMotion = useReducedMotion();
  const y = reducedMotion ? 0 : distance;
  return (
    <motion.div
      {...props}
      ref={ref}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y }}
      transition={{ duration: reducedMotion ? 0.01 : duration, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
});
