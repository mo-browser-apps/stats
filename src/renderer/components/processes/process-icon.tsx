import { useState } from "react";
import { Box } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * App icon for a process row or the detail header: the base64 PNG when
 * available, else (or if it fails to decode) a neutral glyph so every row
 * keeps the same footprint.
 */
export function ProcessIcon({
  iconPngBase64,
  name,
  size = "sm",
}: {
  iconPngBase64?: string
  name: string
  size?: "sm" | "lg"
}) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const box = size === "lg" ? "h-9 w-9 rounded-xl" : "h-5 w-5 rounded-lg";
  const glyph = size === "lg" ? "h-5 w-5" : "h-3 w-3";

  if (iconPngBase64 && iconPngBase64 !== failedSrc) {
    return (
      <img
        src={`data:image/png;base64,${iconPngBase64}`}
        alt=""
        aria-hidden="true"
        className={cn("shrink-0", box)}
        onError={() => setFailedSrc(iconPngBase64)}
      />
    );
  }

  return (
    <span
      className={cn("flex shrink-0 items-center justify-center bg-muted", box)}
      aria-hidden="true"
      title={name}
    >
      <Box className={cn("text-muted-foreground", glyph)} strokeWidth={1.75} />
    </span>
  );
}
