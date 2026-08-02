import { Checkbox } from "@/components/ui/checkbox";

export interface ActionItem {
  id: string;
  text: string;
  completed: boolean;
}

interface ActionItemsListProps {
  items: ActionItem[];
  onToggle: (id: string) => void;
}

export function ActionItemsList({ items, onToggle }: ActionItemsListProps) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">No action items found.</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2">
          <Checkbox
            id={`action-item-${item.id}`}
            checked={item.completed}
            onCheckedChange={() => onToggle(item.id)}
          />
          <label
            htmlFor={`action-item-${item.id}`}
            className={item.completed ? "line-through text-muted-foreground" : ""}
          >
            {item.text}
          </label>
        </li>
      ))}
    </ul>
  );
}
