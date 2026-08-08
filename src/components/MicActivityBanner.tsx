import { Button } from "@/components/ui/button";
import { Mic } from "lucide-react";

interface MicActivityBannerProps {
  onDismiss: () => void;
}

export function MicActivityBanner({ onDismiss }: MicActivityBannerProps) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs bg-muted/60 border rounded-md px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Mic className="h-3 w-3 text-primary" />
        <span>Mic is active — start recording?</span>
      </div>
      <Button variant="ghost" size="sm" className="h-5 text-[10px] px-1.5" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
