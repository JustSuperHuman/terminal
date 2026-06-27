import { Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SocketStatus } from "@/lib/terminal-socket";

export function ConnectionBadge({ status }: { status: SocketStatus }) {
  const open = status === "open";
  return (
    <Badge variant={open ? "secondary" : "warning"} className="gap-1.5">
      {open ? <Wifi className="h-3.5 w-3.5" aria-hidden="true" /> : <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />}
      {open ? "Connected" : status === "connecting" ? "Connecting" : "Offline"}
    </Badge>
  );
}
