import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../../shared/types';

export function useChatNavigation(id: string | undefined, messages: Message[], loading: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState('');
  const schedule = useRef<() => void>(() => {});
  const latest = useCallback(() => {
    follow.current = true;
    setAway(false);
    const element = viewport.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
    schedule.current();
  }, []);
  const jumpTo = useCallback((messageId: string) => {
    const element = viewport.current;
    const question = content.current?.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"]`,
    );
    if (!element || !question) return;
    follow.current = false;
    element.scrollTo({
      top:
        element.scrollTop +
        question.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        16,
      behavior: 'instant',
    });
    setActiveQuestion(messageId);
    schedule.current();
  }, []);
  useLayoutEffect(() => {
    follow.current = true;
    setAway(false);
    setActiveQuestion('');
  }, [id]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let frame = 0;
    let touchY = 0;
    let previousTop = element.scrollTop;
    const measure = () => {
      const bottom = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
      setAway(!bottom);
      const questions = [
        ...(content.current?.querySelectorAll<HTMLElement>('.message.user') ?? []),
      ];
      const edge = element.getBoundingClientRect().top + 90;
      const current = bottom
        ? questions.at(-1)
        : (questions.filter((question) => question.getBoundingClientRect().top <= edge).at(-1) ??
          questions[0]);
      if (current) setActiveQuestion(current.dataset.messageId!);
      return bottom;
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (follow.current) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
        previousTop = element.scrollTop;
        measure();
      });
    };
    schedule.current = update;
    const scroll = () => {
      const bottom = measure();
      if (bottom) follow.current = true;
      else if (!loading && element.scrollTop < previousTop - 1) follow.current = false;
      previousTop = element.scrollTop;
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) follow.current = false;
    };
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY) follow.current = false;
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
        (event.key === ' ' && event.shiftKey)
      )
        follow.current = false;
    };
    element.addEventListener('scroll', scroll, { passive: true });
    element.addEventListener('wheel', wheel, { passive: true });
    element.addEventListener('touchstart', touchStart, { passive: true });
    element.addEventListener('touchmove', touchMove, { passive: true });
    element.addEventListener('keydown', key);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (content.current) observer.observe(content.current);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      schedule.current = () => {};
      element.removeEventListener('scroll', scroll);
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('touchstart', touchStart);
      element.removeEventListener('touchmove', touchMove);
      element.removeEventListener('keydown', key);
    };
  }, [id, loading]);
  useLayoutEffect(() => schedule.current(), [messages]);
  return { viewport, content, away, activeQuestion, latest, jumpTo };
}
