/**
 * The zoom and the pan of the replay map: the window of the map that is shown (a
 * {@link MapViewport}), moved by the wheel (towards the pointer) and by dragging, and reset by a
 * button. Kept apart from the drawing of the map so that the map component only draws, and so that
 * the gestures are read in one place.
 *
 * @packageDocumentation
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { FULL_MAP, panBy, zoomAt, type MapViewport } from './replay-model';

/** How much one notch of the wheel changes the zoom: in when the wheel goes up, out when down. */
const WHEEL_ZOOM_FACTOR = 1.2;

/** The pointer handlers the picture of the map takes, to be spread on it. */
export interface MapPointerHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<SVGSVGElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onLostPointerCapture: () => void;
}

/** What {@link useMapPanZoom} gives the map. */
export interface MapPanZoom {
  /** The ref of the picture of the map (its `<svg>`), which the wheel is attached to. */
  readonly svgRef: RefObject<SVGSVGElement | null>;
  /** The window of the map that is shown. */
  readonly viewport: MapViewport;
  /** Show the whole map again. */
  readonly resetZoom: () => void;
  /** The handlers of the drag, to spread on the picture. */
  readonly pointerHandlers: MapPointerHandlers;
}

/**
 * Hold the window of the map that is shown and move it with the wheel and the pointer.
 *
 * @returns The ref of the picture, the window, the reset and the pointer handlers.
 */
export function useMapPanZoom(): MapPanZoom {
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState<MapViewport>(FULL_MAP);
  // Where the pointer was at the last move of a drag, in screen pixels; `null` when not dragging.
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  // The wheel is attached by hand: React listens to it passively and could not cancel it, so the
  // page would scroll under the map while the player zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      // Where the pointer is in the picture, from 0 to 1 (the middle when nothing is laid out).
      const fractionX = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
      const fractionY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setViewport((current) =>
        zoomAt(
          current,
          {
            left: current.left + fractionX / current.scale,
            top: current.top + fractionY / current.scale,
          },
          factor,
        ),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    // Only the main button drags: a right click must not start a pan.
    if (event.button !== 0) return;
    dragFrom.current = { x: event.clientX, y: event.clientY };
    // Keep the drag when the pointer leaves the picture (jsdom, which the tests run in, has no
    // capture).
    if ('setPointerCapture' in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    // No button down: the release happened elsewhere, so a stuck drag ends here.
    if (event.buttons === 0) {
      dragFrom.current = null;
      return;
    }
    const from = dragFrom.current;
    const rect = event.currentTarget.getBoundingClientRect();
    if (from === null || rect.width <= 0 || rect.height <= 0) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    dragFrom.current = { x: event.clientX, y: event.clientY };
    // The picture follows the pointer: the window moves the other way, by the share of the window
    // the pointer crossed.
    setViewport((current) =>
      panBy(current, -dx / rect.width / current.scale, -dy / rect.height / current.scale),
    );
  }, []);

  const endDrag = useCallback(() => {
    dragFrom.current = null;
  }, []);

  const resetZoom = useCallback(() => {
    setViewport(FULL_MAP);
  }, []);

  return {
    svgRef,
    viewport,
    resetZoom,
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
    },
  };
}
