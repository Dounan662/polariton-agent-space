import React from 'react';
import {createPortal} from 'react-dom';
import {IconChevronDownOutline14, IconCheckOutline16, Tooltip} from './ui/index.ts';
import {useDropdown} from './dropdown.tsx';

type Option = {value: string; label: string; disabled?: boolean};

/** A controlled single-value picker with the same popup surface as command menus.
 * Labels remain readable in the popup even when the closed control is truncated.
 * Disabled options explain retained values without permitting invalid changes. */
export function Select({label, value, options, onChange, disabled = false, onFocus, tooltip, className = ''}: {
  label: string; value: string; options: readonly Option[]; onChange: (value: string) => void;
  disabled?: boolean; onFocus?: () => void; tooltip?: string; className?: string;
}) {
  const popup = useDropdown(disabled);
  const selected = options.find(option=>option.value===value);
  const control = <button type="button" ref={popup.trigger}
      className={`select-trigger ${className}`} aria-label={`${label}: ${selected?.label??value}`} aria-haspopup="listbox"
      aria-expanded={popup.open} aria-controls={popup.open?popup.id:undefined} disabled={disabled}
      onFocus={onFocus} onClick={popup.toggle} onKeyDown={popup.onTriggerKeyDown}>
      <span className="select-label">{selected?.label??value}</span><IconChevronDownOutline14/>
    </button>;
  return <>
    {tooltip?<Tooltip label={tooltip} disabled={popup.open} side="top">{control}</Tooltip>:control}
    {popup.open&&!disabled&&createPortal(<div id={popup.id} ref={popup.menu} role="listbox" aria-label={label}
      className="action-menu select-menu" onKeyDown={popup.onMenuKeyDown} onClick={event=>event.stopPropagation()}>
      {options.map(option=><button key={option.value} type="button" role="option" aria-selected={option.value===value}
        tabIndex={-1} disabled={option.disabled} onClick={()=>{popup.close(true);if(option.value!==value)onChange(option.value);}}>
        <span className="action-label">{option.label}</span>{option.value===value&&<span className="action-icon" aria-hidden="true"><IconCheckOutline16/></span>}
      </button>)}
    </div>,popup.portal)}
  </>;
}
