import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
} from "react";

function shouldAnimatePanelClose(): boolean {
  return typeof window !== "undefined" &&
    window.matchMedia !== undefined &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useMembersOverlay({
  initialOpen = false,
  canShow,
  forceClosed,
  onCloseMembers,
  onOpenChange,
}: {
  initialOpen?: boolean
  canShow: boolean
  forceClosed: boolean
  onCloseMembers: () => void
  onOpenChange?: (open: boolean) => void
}) {
  const [membersOpen, setMembersOpen] = useState(initialOpen);
  const [closing, setClosing] = useState(false);
  const [slideFrom, setSlideFrom] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const inflowGraphRef = useRef<HTMLDivElement>(null);
  const reportOpen = useRef(onOpenChange);
  reportOpen.current = onOpenChange;

  useEffect(() => {
    reportOpen.current?.(membersOpen);
  }, [membersOpen]);

  const measureSlide = useCallback((): number => {
    const content = contentRef.current?.getBoundingClientRect();
    const graph = inflowGraphRef.current?.getBoundingClientRect();
    if (!content || !graph) {
      return 0;
    }
    return Math.max(0, graph.top - content.top);
  }, []);

  const toggleMembers = useCallback(() => {
    setMembersOpen((open) => {
      setSlideFrom(measureSlide());
      setClosing(open && shouldAnimatePanelClose());
      if (open) {
        onCloseMembers();
      }
      return !open;
    });
  }, [measureSlide, onCloseMembers]);

  const onOverlayAnimationEnd = useCallback(
    (event: ReactAnimationEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && closing) {
        setClosing(false);
      }
    },
    [closing],
  );

  useEffect(() => {
    if (forceClosed) {
      setMembersOpen(false);
      setClosing(false);
    }
  }, [forceClosed]);

  return {
    closing,
    contentRef,
    inflowGraphRef,
    overlayMounted: (membersOpen || closing) && canShow,
    overlayStyle: { "--pin-from": `${slideFrom}px` } as CSSProperties,
    toggleMembers,
    onOverlayAnimationEnd,
  };
}
