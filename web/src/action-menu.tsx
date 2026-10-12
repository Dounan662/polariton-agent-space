import React, {type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {IconEllipsisOutline16, Tooltip} from './ui/index.ts';
import {useDropdown} from './dropdown.tsx';

type Action = {id?: string; label: string; icon: ReactNode; current?: boolean; separatorBefore?: boolean; disabled?: boolean; onSelect: () => void};

/** Commands and project navigation share a keyboard-accessible action menu.
 * Opening the menu never selects its containing row. */
export function ActionMenu({label, actions, children, className = 'menu-trigger'}: {label: string; actions: readonly Action[]; children?: ReactNode; className?: string}) {
  const popup = useDropdown();
  return <>
    <Tooltip label={label} side="bottom" disabled={popup.open}><button ref={popup.trigger} type="button" className={className} aria-label={label}
      aria-haspopup="menu" aria-expanded={popup.open} aria-controls={popup.open ? popup.id : undefined}
      onClick={popup.toggle} onKeyDown={popup.onTriggerKeyDown}>{children??<IconEllipsisOutline16/>}</button></Tooltip>
    {popup.open && createPortal(<div id={popup.id} ref={popup.menu} role="menu" aria-label={label} className="action-menu"
      onKeyDown={popup.onMenuKeyDown} onClick={event=>event.stopPropagation()}>
      {actions.map(action => <React.Fragment key={action.id??action.label}>{action.separatorBefore&&<div role="separator" className="action-divider"/>}<button type="button" role="menuitem" tabIndex={-1} aria-current={action.current?'true':undefined}
        disabled={action.disabled} onClick={() => {popup.close(true); action.onSelect();}}>
        <span className="action-icon" aria-hidden="true">{action.icon}</span><span className="action-label">{action.label}</span>
      </button></React.Fragment>)}
    </div>, popup.portal)}
  </>;
}
