import type { HTMLAttributes } from "react";

type AtomicIconProps = HTMLAttributes<HTMLSpanElement> & {
  size?: "sm" | "md" | "lg";
};

export function AtomicIcon({ size = "md", className = "", ...props }: AtomicIconProps) {
  return <span className={`atomic-icon atomic-icon-${size} ${className}`.trim()} aria-hidden="true" {...props}>
    <span className="atomic-icon-orbit" />
    <span className="atomic-icon-nucleus">ع</span>
  </span>;
}
