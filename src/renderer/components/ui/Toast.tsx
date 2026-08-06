export function Toast(props: { label: string | null }) {
  return props.label ? <div className="toast">{props.label}</div> : null;
}
