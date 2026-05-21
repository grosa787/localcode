import { useRef } from 'react';
import type { ReactNode } from 'react';
import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { prefersReducedMotion } from '../lib/motion';
import styles from './TiltTile.module.css';

interface TiltTileProps {
  readonly children: ReactNode;
  readonly featured?: boolean;
}

/**
 * Cursor-aware tilt — pointer position → rotate transform. Soft spring so
 * the motion feels analogue. Disabled under prefers-reduced-motion (we just
 * render a flat card).
 */
export function TiltTile({ children, featured = false }: TiltTileProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const springX = useSpring(x, { stiffness: 220, damping: 18 });
  const springY = useSpring(y, { stiffness: 220, damping: 18 });

  const rotateX = useTransform(springY, [-0.5, 0.5], ['7deg', '-7deg']);
  const rotateY = useTransform(springX, [-0.5, 0.5], ['-7deg', '7deg']);

  const reduced = prefersReducedMotion();

  const onMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (reduced) return;
    const el = ref.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    x.set(px);
    y.set(py);
  };

  const onLeave = (): void => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.div
      ref={ref}
      className={`${styles.tile} ${featured ? styles.featured : ''}`}
      style={reduced ? undefined : { rotateX, rotateY, transformPerspective: 800 }}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      {children}
    </motion.div>
  );
}
