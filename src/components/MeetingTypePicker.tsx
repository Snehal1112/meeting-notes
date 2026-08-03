import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MeetingType } from "@/lib/storage";
import { Sparkles, Users, RotateCcw, Lightbulb, AlertTriangle, type LucideIcon } from "lucide-react";

export const MEETING_TYPES: { value: MeetingType; label: string; icon: LucideIcon }[] = [
  { value: "AutoDetect", label: "Auto-detect", icon: Sparkles },
  { value: "Standup", label: "Standup", icon: Users },
  { value: "Retrospective", label: "Retrospective", icon: RotateCcw },
  { value: "FeatureRequest", label: "Feature Request", icon: Lightbulb },
  { value: "Incident", label: "Incident", icon: AlertTriangle },
];

interface MeetingTypePickerProps {
  value: MeetingType;
  onChange: (value: MeetingType) => void;
  disabled?: boolean;
}

// The chosen type decides which notes prompt the summary crate uses, so it
// has to be set before recording starts rather than at summarize time.
export function MeetingTypePicker({ value, onChange, disabled }: MeetingTypePickerProps) {
  const selected = MEETING_TYPES.find((type) => type.value === value);
  const SelectedIcon = selected?.icon;
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as MeetingType)}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label="Meeting type"
        className="w-fit gap-1.5 h-8 rounded-full text-xs border-dashed"
      >
        {SelectedIcon && <SelectedIcon className="text-muted-foreground" />}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEETING_TYPES.map((type) => (
          <SelectItem key={type.value} value={type.value}>
            <type.icon className="text-muted-foreground" />
            {type.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
