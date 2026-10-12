import {useId, useLayoutEffect, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';

/** Anchored popup behavior shared by command menus and value pickers. The popup
 * owns dismissal and keyboard focus; its dialog retains top-layer ownership. */
export function useDropdown(disabled = false) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<'first' | 'last' | 'selected'>('selected'), search = useRef('');
  const id = useId();
  const close = (restore: boolean) => {
    setOpen(false);
    if (restore) trigger.current?.focus({preventScroll: true});
  };
  useLayoutEffect(() => {
    if (disabled) {setOpen(false); return;}
    if (!open) return;
    const list = menu.current!, anchor = trigger.current!;
    search.current = '';
    const place = () => {
      const rect = anchor.getBoundingClientRect(), style = getComputedStyle(list);
      const margin = parseFloat(style.getPropertyValue('--menu-viewport-gap'));
      const gap = parseFloat(style.getPropertyValue('--menu-anchor-gap'));
      const {width, height} = list.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - margin;
      const top = below >= height || below >= rect.top - margin ? rect.bottom + gap : rect.top - height - gap;
      list.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`;
      list.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`;
    };
    place();
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const selected = buttons.find(button => button.getAttribute('aria-selected') === 'true');
    (initialFocus.current === 'last' ? buttons.at(-1) : initialFocus.current === 'selected' ? selected ?? buttons[0] : buttons[0])?.focus({preventScroll: true});
    document.activeElement instanceof HTMLElement && list.contains(document.activeElement) && document.activeElement.scrollIntoView({block: 'nearest'});
    const outside = (event: Event) => {
      if (event.target instanceof Node && !list.contains(event.target) && !anchor.contains(event.target)) setOpen(false);
    };
    const observer = new ResizeObserver(place);
    observer.observe(list);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, disabled]);
  return {
    open, id, trigger, menu, close,
    // A body portal is inert behind a native modal, regardless of z-index.
    portal: trigger.current?.closest('dialog') ?? document.body,
    toggle: () => {initialFocus.current = 'selected'; setOpen(value => !value);},
    onTriggerKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); initialFocus.current = event.key === 'ArrowUp' ? 'last' : 'selected'; setOpen(true);
      } else if (event.key === 'Escape' && open) {event.preventDefault(); event.stopPropagation(); close(true);}
    },
    onMenuKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(true); return;}
      // Restore the trigger before the browser resolves the next tab stop.
      if (event.key === 'Tab') {close(true); return;}
      if (!buttons.length) return;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); search.current = '';
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]!.focus(); return;
      }
      if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const char = event.key.toLocaleLowerCase(), prefix = search.current + char;
        const ordered = [...buttons.slice(index + 1), ...buttons.slice(0, index + 1)];
        let match = ordered.find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(prefix));
        search.current = match ? prefix : char;
        match ??= ordered.find(button => button.textContent?.trim().toLocaleLowerCase().startsWith(char));
        match?.focus();
      }
    },
  };
}
