import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MeetingType } from "@/lib/storage";

const MEETING_TYPES: { value: MeetingType; label: string }[] = [
  { value: "AutoDetect", label: "Auto-detect" },
  { value: "Standup", label: "Standup" },
  { value: "Retrospective", label: "Retrospective" },
  { value: "FeatureRequest", label: "Feature Request" },
  { value: "Incident", label: "Incident" },
];

interface MeetingTypePickerProps {
  value: MeetingType;
  onChange: (value: MeetingType) => void;
  disabled?: boolean;
}

// The chosen type decides which notes prompt the summary crate uses, so it
// has to be set before recording starts rather than at summarize time.
export function MeetingTypePicker({ value, onChange, disabled }: MeetingTypePickerProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as MeetingType)}
      disabled={disabled}
    >
      <SelectTrigger aria-label="Meeting type" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEETING_TYPES.map((type) => (
          <SelectItem key={type.value} value={type.value}>
            {type.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
