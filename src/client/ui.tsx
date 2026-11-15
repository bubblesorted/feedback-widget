/**
 * The widget's own small button and icons, so it looks the same on every site. Sites theme it through the CSS
 * variables in styles.css, never by restyling its parts.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconName = "x" | "target" | "image" | "record" | "check" | "message";

const PATHS: Record<IconName, ReactNode> = {
  x: <path d="M18 6 6 18M6 6l12 12" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  record: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  message: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="fbw-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
  size?: "sm" | "md";
  icon?: IconName;
  kbd?: string;
  label?: string;
};

export function Button({ variant = "default", size = "md", icon, kbd, label, children, className, type, ...rest }: ButtonProps) {
  const iconOnly = !children && !!icon;
  return (
    <button
      type={type ?? "button"}
      className={["fbw-btn", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? "" : undefined}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children}
      {kbd ? <kbd className="fbw-kbd">{kbd}</kbd> : null}
    </button>
  );
}
