import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {defaultRangeExtractor, useVirtualizer, type Range} from '@tanstack/react-virtual';
import type {SourceObservation} from './observation.ts';
import {conversationBudget as budget, HistoryDemand, readingPosition, type ReadingPosition} from './conversation-history.ts';

/** Own conversation geometry and reading memory. Source observation lives beyond
 * this viewport, and virtual row mounts have no effect on ingestion or execution. */
export function ConversationViewport({source, active, keys, children}: {
  source: SourceObservation; active: boolean; keys: readonly string[];
  children: (index: number) => React.ReactNode;
}) {
  useSyncExternalStore(source.subscribe, source.getSnapshot);
  const element = useRef<HTMLDivElement>(null);
  const geometryChanged = useRef<() => void>(() => {});
  const restoreFrame = useRef<number | null>(null);
  const mountedRows = useRef(new Map<string, HTMLDivElement>());
  const storageKey = `polariton.reading.${source.scope.workerId}`;
  const memory = source.presentationState;
  const [storageError, setStorageError] = useState('');
  const [position] = useState(() => {
    if (memory.has('chat:reading')) return memory.get('chat:reading') as ReadingPosition;
    try {return readingPosition(localStorage.getItem(storageKey));} catch {return null;}
  });
  const saved = useRef(position);
  const restore = useRef<ReadingPosition | 'tail' | null>(position && !position.atBottom ? position : 'tail');
  const latestRequest = useRef(source.latestRequest);
  const wasActive = useRef(false);
  const [restorationNotice, setRestorationNotice] = useState('');
  const [held, setHeld] = useState<readonly string[]>([]);
  const demand = useMemo(() => new HistoryDemand(source), [source]);
  const paused = useSyncExternalStore(demand.subscribe, demand.getSnapshot);
  const indices = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const rangeExtractor = useCallback((range: Range) => [...new Set([
    ...defaultRangeExtractor(range), ...held.flatMap(key => indices.has(key) ? [indices.get(key)!] : []),
  ])].sort((a, b) => a - b), [held, indices]);
  // Arm semantic restoration before the virtualizer's layout effects re-enable
  // its observers. Re-enable starts with an estimated offset; publishing that
  // geometry as a bookmark would overwrite the reader's last visible position.
  // The committed-active guard below also excludes ref-phase measurements.
  useLayoutEffect(() => {
    if (active) {
      if (!wasActive.current) restore.current = saved.current && !saved.current.atBottom ? saved.current : 'tail';
      wasActive.current = true;
    } else {
      wasActive.current = false;
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = null;
      demand.update(false, false);
    }
  }, [active, demand]);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // Keep resize compensation and row positions in the same browser paint.
    // React only owns row membership; TanStack owns every geometry write.
    directDomUpdates: true, useFlushSync: false, count: keys.length, getScrollElement: () => element.current,
    getItemKey: useCallback((index: number) => keys[index]!, [keys]),
    estimateSize: () => budget.estimatedRowHeight,
    overscan: budget.overscanRows, rangeExtractor, enabled: active,
    anchorTo: 'end', followOnAppend: true, scrollEndThreshold: budget.endThreshold,
    onChange: () => geometryChanged.current(),
  });
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const write = useCallback(() => {
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    persistTimer.current = null;
    if (!saved.current) return;
    try {localStorage.setItem(storageKey, JSON.stringify(saved.current));}
    catch {setStorageError('Reading position cannot be saved in this browser.');}
  }, [storageKey]);
  const remember = useCallback(() => {
    if (!active || !wasActive.current || restore.current || !source.hasHistory) return;
    const offset = virtual.scrollOffset ?? 0;
    const row = virtual.getVirtualItems().find(item => item.end > offset);
    if (!row) return;
    saved.current = {key: String(row.key), offset: row.start - offset, atBottom: virtual.isAtEnd()};
    memory.set('chat:reading', saved.current);
    if (persistTimer.current !== null) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(write, budget.persistDelayMs);
  }, [active, source, virtual, memory, write]);
  const navigate = () => {
    restore.current = null;
    setRestorationNotice('');
  };
  const needsEarlier = (offset = virtual.scrollOffset ?? 0) => {
    const target = restore.current;
    return target ? typeof target !== 'string' && !indices.has(target.key) : offset <= budget.prefetchPixels;
  };
  const alignRestoration = () => {
    const pending = restore.current;
    if (!pending || restoreFrame.current !== null) return;
    restoreFrame.current = requestAnimationFrame(() => {
      restoreFrame.current = null;
      if (!wasActive.current || restore.current !== pending || virtual.options.count === 0) return;
      const key = pending === 'tail' ? virtual.options.getItemKey(virtual.options.count - 1) : pending.key;
      const items = virtual.getVirtualItems();
      const target = items.find(item => item.key === key);
      // A bookmark inside an estimated row would be adjusted again by its
      // first measurement. Tail landing also needs the measured scroll extent.
      // onChange resumes this one-time navigation when measurement completes.
      if (!target || items.some(item => {
        const node = mountedRows.current.get(String(item.key));
        return !node || item.size !== Math.round(node.getBoundingClientRect().height);
      })) return;
      if (pending === 'tail') virtual.scrollToEnd();
      else virtual.scrollToOffset(Math.max(0, target.start - pending.offset));
      restore.current = null;
      demand.update(active, false);
    });
  };
  // Direct geometry updates need not render React. Capture reading state after
  // the library has applied each update, rather than from an earlier DOM scroll event.
  geometryChanged.current = () => {
    if (!active || !wasActive.current) return;
    alignRestoration();
    remember();
    demand.update(active, needsEarlier());
  };
  // A view becoming visible restores semantic position once. TanStack alone
  // compensates later prepends and resizes; there is no competing scrollTop loop.
  useLayoutEffect(() => {
    if (!active) return;
    if (latestRequest.current !== source.latestRequest) {
      latestRequest.current = source.latestRequest; restore.current = 'tail';
    }
    if (!source.hasHistory) return;
    const pending = restore.current;
    if (pending === 'tail') {
      virtual.scrollToEnd();
      if (keys.length) alignRestoration(); else restore.current = null;
    }
    else if (pending) {
      const index = indices.get(pending.key);
      if (index !== undefined) {
        const item = virtual.getVirtualItems().find(item => item.key === pending.key);
        if (!mountedRows.current.has(pending.key) || !item) {
          virtual.scrollToIndex(index, {align: 'start'});
        } else alignRestoration();
      } else if (!source.hasMore && source.status === 'ready') {
        virtual.scrollToOffset(0); restore.current = null;
        setRestorationNotice('The saved message is unavailable. Showing the earliest retained message.');
      }
    }
    demand.update(active, needsEarlier());
    remember();
  });
  useEffect(() => () => {demand.dispose();if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);}, [demand]);
  useEffect(() => {
    if (!active) write();
  }, [active, write]);
  useEffect(() => {
    const flush = () => write();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush); write();};
  }, [write]);
  // Retain just the mounted rows containing active focus or selected text. This
  // deliberate interaction exception prevents detached DOM from destroying a copy.
  useEffect(() => {
    const retain = () => {
      const host = element.current;
      if (!active || !host) return;
      const selection = document.getSelection();
      const selected = [...host.querySelectorAll<HTMLElement>('[data-chat-row]')].filter(row =>
        row.contains(document.activeElement) || Boolean(selection && !selection.isCollapsed && selection.containsNode(row, true))
      ).map(row => row.dataset.chatRow!);
      setHeld(previous => previous.length === selected.length && previous.every((key, index) => key === selected[index]) ? previous : selected);
    };
    document.addEventListener('selectionchange', retain);
    document.addEventListener('focusin', retain);
    document.addEventListener('focusout', retain);
    return () => {document.removeEventListener('selectionchange', retain); document.removeEventListener('focusin', retain); document.removeEventListener('focusout', retain);};
  }, [active]);
  return <div className="conversation-viewport">
    <div className="history" ref={element} tabIndex={0} aria-label="Conversation history"
      onWheel={navigate} onTouchStart={navigate} onPointerDown={navigate}
      onKeyDown={event => {if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) navigate();}}
      >
      {!keys.length && <div className="conversation-empty"><h2>What would you like to explore?</h2></div>}
      <div className="conversation-rows" ref={virtual.containerRef}>
        {virtual.getVirtualItems().map(item => <div key={item.key} data-chat-row={String(item.key)} data-index={item.index}
          ref={node => {
            if (node) mountedRows.current.set(String(item.key), node);
            else mountedRows.current.delete(String(item.key));
            virtual.measureElement(node);
          }} className="conversation-row">
          {children(item.index)}
        </div>)}
      </div>
    </div>
    <div className="history-status" role="status">
      {paused ? <>{paused} <button onClick={() => demand.retry()}>Continue loading</button></> :
        source.loadingOlder ? 'Loading earlier messages…' : null}
      {restorationNotice}{storageError}
    </div>
  </div>;
}
