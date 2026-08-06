import type { ReactNode } from "react";

export function EmptyState(props: { action?: ReactNode; icon?: ReactNode; subtitle?: ReactNode; title: ReactNode }) {
  return (
    <div className="ui-empty-state">
      {props.icon ? <div className="ui-empty-icon">{props.icon}</div> : null}
      <strong>{props.title}</strong>
      {props.subtitle ? <p>{props.subtitle}</p> : null}
      {props.action ? <div className="ui-empty-action">{props.action}</div> : null}
    </div>
  );
}
