import { useState } from "react";
import { Box, Cog } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * App icon for a process row or the detail header. Renders the volatile base64
 * PNG from NSWorkspace when one is available; otherwise (and if the image fails
 * to decode) it falls back to a neutral lucide glyph so every row keeps the same
 * icon footprint. The synthetic System group has no PNG by design and gets a
 * gear glyph instead of the generic box. `size` scales the box for the larger
 * detail header.
 *
 * Shared by {@link "@/components/processes/process-row".ProcessRow} (the list
 * rows and member rows) and the detail header, so it lives on its own rather
 * than inside the row component.
 */
export function ProcessIcon({
  iconPngBase64,
  name,
  size = "sm",
  system = false,
}: {
  iconPngBase64?: string
  name: string
  size?: "sm" | "lg"
  system?: boolean
}) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const box = size === "lg" ? "h-9 w-9 rounded-xl" : "h-5 w-5 rounded-lg";
  const glyph = size === "lg" ? "h-5 w-5" : "h-3 w-3";
  const Glyph = system ? Cog : Box;

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
      <Glyph className={cn("text-muted-foreground", glyph)} strokeWidth={1.75} />
    </span>
  );
}
